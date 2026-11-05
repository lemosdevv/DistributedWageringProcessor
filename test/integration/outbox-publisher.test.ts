import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { OutboxPublisher } from '../../src/application/outbox/outbox-publisher';
import { noopMetrics } from '../../src/application/ports/metrics';
import { silentLogger } from '../../src/application/ports/observability';
import type { EventPublisher } from '../../src/application/ports/outbox';
import type { Clock } from '../../src/application/ports/system';
import { MikroOrmOutboxRepository } from '../../src/infrastructure/persistence/mikro-orm-outbox-repository';
import { SqsEventPublisher } from '../../src/infrastructure/sqs/sqs-event-publisher';
import { createTestOrm, resetDatabase, sql } from '../helpers/database';
import { createTestQueues, testSqs, type TestQueues } from '../helpers/sqs';
import { buildUseCases, keyOf, wagerCommand } from '../helpers/wagering';

let orm: MikroORM;
let useCases: ReturnType<typeof buildUseCases>;
let queues: TestQueues;
let walletId: string;

function publisherWith(eventPublisher: EventPublisher, clock: Clock = { now: () => new Date() }, batchSize = 10) {
  return new OutboxPublisher(
    new MikroOrmOutboxRepository(orm),
    eventPublisher,
    clock,
    { batchSize, leaseMs: 30_000 },
    noopMetrics,
    silentLogger,
  );
}

const sqsPublisher = () => new SqsEventPublisher(testSqs, queues.queueUrl);

async function receiveAll(): Promise<{ eventId: string; eventType: string }[]> {
  const received: { eventId: string; eventType: string }[] = [];
  for (let emptyPolls = 0; emptyPolls < 2; ) {
    const { Messages = [] } = await testSqs.send(
      new ReceiveMessageCommand({ QueueUrl: queues.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
    );
    if (Messages.length === 0) emptyPolls++;
    for (const message of Messages) {
      received.push(JSON.parse(message.Body ?? '{}'));
      await testSqs.send(new DeleteMessageCommand({ QueueUrl: queues.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  return received;
}

async function pendingCount(): Promise<number> {
  const [row] = await sql<{ count: string }>(orm, 'select count(*) from outbox_messages where published_at is null');
  return Number(row?.count);
}

async function placeBets(count: number) {
  for (let i = 0; i < count; i++) {
    const command = wagerCommand(walletId, { money: { amount: '1.00', currency: 'BRL' } });
    await useCases.processWager.execute(command, { idempotencyKey: keyOf(command), correlationId: 'c' });
  }
}

beforeAll(async () => {
  orm = await createTestOrm();
  useCases = buildUseCases(orm);
});

afterAll(async () => {
  await orm.close(true);
});

beforeEach(async () => {
  await resetDatabase(orm);
  queues = await createTestQueues();
  walletId = (
    await useCases.createWallet.execute({ playerId: 'player-1', initialBalance: { amount: '1000.00', currency: 'BRL' } }, 'c')
  ).id;
});

afterEach(async () => {
  await queues.dispose();
});

describe('OutboxPublisher', () => {
  test('publishes committed events with the envelope and marks them published', async () => {
    await placeBets(1);
    // Abertura (2 eventos) + aposta (2 eventos)
    expect(await pendingCount()).toBe(4);

    const result = await publisherWith(sqsPublisher()).publishBatch();
    expect(result).toEqual({ claimed: 4, published: 4, failed: 0 });
    expect(await pendingCount()).toBe(0);

    const events = await receiveAll();
    expect(events.map((event) => event.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
    expect(events[0]).toMatchObject({ eventId: expect.any(String), version: 1, correlationId: expect.any(String) });
  });

  test('two concurrent publishers over the same outbox publish every event exactly once', async () => {
    await placeBets(40);
    const total = await pendingCount();

    const claimedIds: string[] = [];
    const recording = (): EventPublisher => {
      const inner = sqsPublisher();
      return {
        publish: async (message) => {
          claimedIds.push(message.id);
          await inner.publish(message);
        },
      };
    };
    const first = publisherWith(recording(), undefined, 7);
    const second = publisherWith(recording(), undefined, 7);

    const drainWith = async (publisher: OutboxPublisher) => {
      while ((await publisher.publishBatch()).claimed > 0) {}
    };
    await Promise.all([drainWith(first), drainWith(second)]);

    expect(await pendingCount()).toBe(0);
    expect(claimedIds).toHaveLength(total);
    expect(new Set(claimedIds).size).toBe(total);
    const received = await receiveAll();
    expect(new Set(received.map((event) => event.eventId)).size).toBe(total);
  });

  test('crash after commit and before publish: another instance publishes the events', async () => {
    // A transação financeira commitou; o processo "morreu" antes de qualquer publicação
    await placeBets(1);
    expect(await pendingCount()).toBe(4);

    const anotherInstance = publisherWith(sqsPublisher());
    await anotherInstance.publishBatch();
    expect(await pendingCount()).toBe(0);
    expect(await receiveAll()).toHaveLength(4);
  });

  test('crash after claiming: the lease expires and another publisher takes over', async () => {
    await placeBets(1);
    let now = new Date();
    const clock: Clock = { now: () => now };

    // Instância A reivindica e morre antes de publicar
    const claimed = await new MikroOrmOutboxRepository(orm).claimDue(now, 30_000, 10);
    expect(claimed).toHaveLength(4);

    // Dentro da lease, ninguém mais pega as mensagens
    expect((await publisherWith(sqsPublisher(), clock).publishBatch()).claimed).toBe(0);

    // Lease expirada: instância B publica
    now = new Date(now.getTime() + 31_000);
    expect((await publisherWith(sqsPublisher(), clock).publishBatch()).published).toBe(4);
    expect(await pendingCount()).toBe(0);
  });

  test('a publish failure schedules a retry with backoff and succeeds later', async () => {
    await placeBets(1);
    let now = new Date();
    const clock: Clock = { now: () => now };
    let available = false;
    const flaky: EventPublisher = {
      publish: async (message) => {
        if (!available) throw new Error('sqs unavailable');
        await sqsPublisher().publish(message);
      },
    };
    const publisher = publisherWith(flaky, clock);

    expect(await publisher.publishBatch()).toMatchObject({ claimed: 4, failed: 4 });
    const [row] = await sql<{ attempts: number }>(orm, 'select max(attempts) as attempts from outbox_messages');
    expect(Number(row?.attempts)).toBe(1);
    expect((await publisher.publishBatch()).claimed).toBe(0);

    available = true;
    now = new Date(now.getTime() + 2_000);
    expect(await publisher.publishBatch()).toMatchObject({ published: 4 });
    expect(await pendingCount()).toBe(0);
  });

  test('a duplicate publication is safe: the eventId identifies the event', async () => {
    await placeBets(1);
    const repository = new MikroOrmOutboxRepository(orm);
    const [message] = await repository.claimDue(new Date(), 0, 1);
    // Publica duas vezes o mesmo evento (ex.: publicou e morreu antes do markPublished)
    await sqsPublisher().publish(message!);
    await sqsPublisher().publish(message!);
    const received = await receiveAll();
    expect(new Set(received.map((event) => event.eventId))).toEqual(new Set([message!.id]));
  });
});
