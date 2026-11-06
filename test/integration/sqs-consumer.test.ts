import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { noopMetrics } from '../../src/application/ports/metrics';
import { silentLogger } from '../../src/application/ports/observability';
import {
  MessageOutcome,
  SqsWagerConsumer,
  type WagerProcessor,
} from '../../src/infrastructure/sqs/sqs-wager-consumer';
import { createTestOrm, resetDatabase, sql } from '../helpers/database';
import { approximateCount, createTestQueues, drain, sendWagerMessage, testSqs, type TestQueues } from '../helpers/sqs';
import { buildUseCases, wagerCommand, walletConsistency } from '../helpers/wagering';

let orm: MikroORM;
let useCases: ReturnType<typeof buildUseCases>;
let queues: TestQueues;
let walletId: string;

function consumerWith(processor: WagerProcessor, overrides: Partial<{ shutdownTimeoutMs: number }> = {}) {
  return new SqsWagerConsumer(
    testSqs,
    processor,
    {
      queueUrl: queues.queueUrl,
      dlqUrl: queues.dlqUrl,
      consumerName: 'test-consumer',
      waitTimeSeconds: 1,
      maxMessages: 10,
      retryBaseSeconds: 1,
      retryMaxSeconds: 2,
      shutdownTimeoutMs: overrides.shutdownTimeoutMs ?? 10_000,
    },
    noopMetrics,
    silentLogger,
  );
}

const transientError = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), { code: 'ECONNREFUSED' });

async function pollUntil(consumer: SqsWagerConsumer, predicate: (outcomes: MessageOutcome[]) => boolean, attempts = 10) {
  const all: MessageOutcome[] = [];
  for (let i = 0; i < attempts; i++) {
    all.push(...(await consumer.pollOnce()));
    if (predicate(all)) return all;
  }
  return all;
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
  queues = await createTestQueues(2);
  walletId = (
    await useCases.createWallet.execute({ playerId: 'player-1', initialBalance: { amount: '100.00', currency: 'BRL' } }, 'c')
  ).id;
});

afterEach(async () => {
  await queues.dispose();
});

describe('SqsWagerConsumer', () => {
  test('processes a message through the same use case and acks after commit', async () => {
    await sendWagerMessage(queues.queueUrl, wagerCommand(walletId));
    const outcomes = await consumerWith(useCases.processWager).pollOnce();

    expect(outcomes).toEqual([MessageOutcome.Acked]);
    expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '75.00', rebuilt: '75.00' });
    expect(await approximateCount(queues.queueUrl)).toBe(0);
    const [inbox] = await sql<{ consumer_name: string }>(orm, 'select consumer_name from inbox_messages');
    expect(inbox?.consumer_name).toBe('test-consumer');
  });

  test('a business rejection is terminal: persisted as REJECTED and acked', async () => {
    await sendWagerMessage(queues.queueUrl, wagerCommand(walletId, { money: { amount: '500.00', currency: 'BRL' } }));
    expect(await consumerWith(useCases.processWager).pollOnce()).toEqual([MessageOutcome.Acked]);
    const [row] = await sql<{ status: string; failure_code: string }>(
      orm,
      `select status, failure_code from wager_transactions where kind = 'BET'`,
    );
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
  });

  test('redelivery of the same messageId produces a single effect', async () => {
    const command = wagerCommand(walletId);
    await sendWagerMessage(queues.queueUrl, command, { messageId: 'msg-dup' });
    await sendWagerMessage(queues.queueUrl, command, { messageId: 'msg-dup' });

    const outcomes = await pollUntil(consumerWith(useCases.processWager), (all) => all.length >= 2);
    expect(outcomes).toEqual([MessageOutcome.Acked, MessageOutcome.Acked]);
    expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '75.00', entries: 2 });
  });

  test('a transient failure is retried with backoff and then processed exactly once', async () => {
    let calls = 0;
    const flaky: WagerProcessor = {
      execute: async (command, ctx) => {
        calls++;
        if (calls === 1) throw transientError();
        return useCases.processWager.execute(command, ctx);
      },
    };
    await sendWagerMessage(queues.queueUrl, wagerCommand(walletId));
    const consumer = consumerWith(flaky);

    expect(await consumer.pollOnce()).toEqual([MessageOutcome.RetryScheduled]);
    const outcomes = await pollUntil(consumer, (all) => all.includes(MessageOutcome.Acked));
    expect(outcomes).toContain(MessageOutcome.Acked);
    expect(calls).toBe(2);
    expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '75.00', entries: 2 });
  });

  test('worker dies after the commit and before the ack: the redelivery is a replay', async () => {
    let crashed = false;
    const crashAfterCommit: WagerProcessor = {
      execute: async (command, ctx) => {
        const result = await useCases.processWager.execute(command, ctx);
        if (!crashed) {
          crashed = true;
          throw new Error('process killed after commit, before ack');
        }
        return result;
      },
    };
    await sendWagerMessage(queues.queueUrl, wagerCommand(walletId));
    const consumer = consumerWith(crashAfterCommit);

    expect(await consumer.pollOnce()).toEqual([MessageOutcome.RetryScheduled]);
    expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '75.00', entries: 2 });

    await pollUntil(consumer, (all) => all.includes(MessageOutcome.Acked));
    expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '75.00', rebuilt: '75.00', entries: 2 });
    expect(await approximateCount(queues.queueUrl)).toBe(0);
  });

  test.each([
    ['malformed JSON', '{ not json', 'INVALID_PAYLOAD'],
    ['wrong message type', JSON.stringify({ messageId: 'm', type: 'Other', occurredAt: new Date().toISOString(), data: {} }), 'INVALID_PAYLOAD'],
  ])('a permanent error (%s) goes to the DLQ immediately', async (_name, rawBody, reason) => {
    await sendWagerMessage(queues.queueUrl, wagerCommand(walletId), { rawBody });
    expect(await consumerWith(useCases.processWager).pollOnce()).toEqual([MessageOutcome.SentToDlq]);
    expect(await approximateCount(queues.queueUrl)).toBe(0);
    const dead = await drain(queues.dlqUrl);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.reason).toBe(reason);
  });

  test('OPENING and unknown wallets are permanent errors', async () => {
    await sendWagerMessage(queues.queueUrl, wagerCommand(walletId, { kind: 'OPENING' }));
    await sendWagerMessage(queues.queueUrl, wagerCommand(Bun.randomUUIDv7()));
    const outcomes = await pollUntil(consumerWith(useCases.processWager), (all) => all.length >= 2);
    expect(outcomes).toEqual([MessageOutcome.SentToDlq, MessageOutcome.SentToDlq]);
    const reasons = (await drain(queues.dlqUrl)).map((message) => message.reason).sort();
    expect(reasons).toEqual(['INTERNAL_KIND_NOT_ALLOWED', 'WALLET_NOT_FOUND']);
  });

  test('a message that keeps failing transiently is moved to the DLQ by the redrive policy', async () => {
    const alwaysDown: WagerProcessor = {
      execute: async () => {
        throw transientError();
      },
    };
    await sendWagerMessage(queues.queueUrl, wagerCommand(walletId));
    const consumer = consumerWith(alwaysDown);

    // maxReceiveCount = 2: duas tentativas e o SQS move a mensagem para a DLQ
    await pollUntil(consumer, () => false, 6);
    expect(await approximateCount(queues.queueUrl)).toBe(0);
    expect(await drain(queues.dlqUrl)).toHaveLength(1);
    expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '100.00', entries: 1 });
  });

  test('different FIFO groups run in parallel while each group keeps its order', async () => {
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const observing: WagerProcessor = {
      execute: async (command, ctx) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Bun.sleep(300);
        order.push(command.externalTransactionId);
        inFlight--;
        return useCases.processWager.execute(command, ctx);
      },
    };
    const commands = Array.from({ length: 6 }, (_, i) => wagerCommand(walletId, { externalTransactionId: `ordered-${i}` }));
    // Grupo A: 0, 1, 2 · Grupo B: 3, 4, 5
    for (const [i, command] of commands.entries()) {
      await sendWagerMessage(queues.queueUrl, command, { groupId: i < 3 ? 'group-a' : 'group-b' });
    }

    const outcomes = await pollUntil(consumerWith(observing), (all) => all.length >= 6);
    expect(outcomes.every((outcome) => outcome === MessageOutcome.Acked)).toBe(true);
    expect(maxInFlight).toBe(2);
    expect(order.filter((id) => ['ordered-0', 'ordered-1', 'ordered-2'].includes(id))).toEqual(['ordered-0', 'ordered-1', 'ordered-2']);
    expect(order.filter((id) => ['ordered-3', 'ordered-4', 'ordered-5'].includes(id))).toEqual(['ordered-3', 'ordered-4', 'ordered-5']);
    expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '0.00', rebuilt: '0.00', entries: 5 });
  });

  test('SIGTERM: stop() lets the in-flight message finish and ack before returning', async () => {
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    const slow: WagerProcessor = {
      execute: async (command, ctx) => {
        started();
        await Bun.sleep(500);
        return useCases.processWager.execute(command, ctx);
      },
    };
    await sendWagerMessage(queues.queueUrl, wagerCommand(walletId));
    const consumer = consumerWith(slow);
    consumer.start();

    await inFlight;
    await consumer.stop();

    expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '75.00', entries: 2 });
    expect(await approximateCount(queues.queueUrl)).toBe(0);
  });
});
