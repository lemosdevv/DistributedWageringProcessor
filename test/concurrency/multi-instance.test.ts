import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, resetDatabase, sql } from '../helpers/database';
import { call } from '../helpers/http-app';
import { eventually, spawnInstance, type AppInstance, type InstanceQueues } from '../helpers/instances';
import { approximateCount, createTestQueues, sendWagerMessage, testSqs, type TestQueues } from '../helpers/sqs';
import { buildUseCases, wagerCommand, walletConsistency } from '../helpers/wagering';

/*
 * Processos reais da aplicação (src/main.ts), cada um com API, consumidor SQS,
 * publisher da outbox e worker de pendências, competindo pelo mesmo banco e filas.
 */
let orm: MikroORM;
let useCases: ReturnType<typeof buildUseCases>;
let wagerQueues: TestQueues;
let eventQueues: TestQueues;
let instances: AppInstance[] = [];
let walletId: string;
const PLAYER = 'multi-instance-player';

const queues = (): InstanceQueues => ({
  wagerQueue: wagerQueues.queueUrl,
  wagerDlq: wagerQueues.dlqUrl,
  eventsQueue: eventQueues.queueUrl,
});

async function scalar(query: string, params: unknown[] = []): Promise<number> {
  const [row] = await sql<{ value: string }>(orm, query, params);
  return Number(row?.value ?? 0);
}

const betCount = () => scalar(`select count(*) as value from wager_transactions where kind = 'BET' and wallet_id = ?`, [walletId]);
const pendingOutbox = () => scalar('select count(*) as value from outbox_messages where published_at is null');

async function publishedEventIds(): Promise<string[]> {
  const ids: string[] = [];
  for (let empty = 0; empty < 2; ) {
    const { Messages = [] } = await testSqs.send(
      new ReceiveMessageCommand({ QueueUrl: eventQueues.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
    );
    if (Messages.length === 0) empty++;
    for (const message of Messages) {
      ids.push(JSON.parse(message.Body ?? '{}').eventId);
      await testSqs.send(new DeleteMessageCommand({ QueueUrl: eventQueues.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  return ids;
}

async function assertFinalInvariant(expected: { balance: string; debits: number }) {
  const consistency = await walletConsistency(orm, walletId);
  expect(consistency.stored).toBe(expected.balance);
  // Invariante final de todos os testes (§13)
  expect(consistency.rebuilt).toBe(consistency.stored);
  expect(
    await scalar(`select count(*) as value from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId]),
  ).toBe(expected.debits);
  // Nenhuma operação do provider existe duas vezes
  expect(
    await scalar(
      `select count(*) as value from (select external_transaction_id from wager_transactions
        group by provider_id, external_transaction_id having count(*) > 1) duplicated`,
    ),
  ).toBe(0);
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
  wagerQueues = await createTestQueues(5, 5);
  eventQueues = await createTestQueues();
  walletId = (
    await useCases.createWallet.execute({ playerId: PLAYER, initialBalance: { amount: '1000.00', currency: 'BRL' } }, 'c')
  ).id;
});

afterEach(async () => {
  await Promise.all(instances.map((instance) => instance.stop()));
  instances = [];
  await wagerQueues.dispose();
  await eventQueues.dispose();
});

describe('multiple instances (§13)', () => {
  test('4. three instances share HTTP and SQS load on one hot wallet without double effects', async () => {
    instances = await Promise.all([
      spawnInstance('a', 4101, queues()),
      spawnInstance('b', 4102, queues()),
      spawnInstance('c', 4103, queues()),
    ]);

    const commands = Array.from({ length: 150 }, () => wagerCommand(walletId, { playerId: PLAYER, money: { amount: '10.00', currency: 'BRL' } }));
    const viaSqs = commands.slice(0, 75);
    const viaHttp = commands.slice(75);

    // SQS: cada mensagem entregue duas vezes (mesmo messageId) e em grupos distintos,
    // para que as 3 instâncias disputem a mesma wallet ao mesmo tempo
    await Promise.all(
      viaSqs.flatMap((command, i) => {
        const messageId = `msg-${i}-${command.externalTransactionId}`;
        return [0, 1].map(() => sendWagerMessage(wagerQueues.queueUrl, command, { messageId, groupId: `g-${i}-${Math.random()}` }));
      }),
    );

    // HTTP: cada requisição enviada duas vezes, em paralelo, para instâncias diferentes
    const httpResponses = await Promise.all(
      viaHttp.flatMap((command, i) =>
        [0, 1].map((copy) =>
          call(instances[(i + copy) % instances.length]!.baseUrl, 'POST', '/wagering/transactions', {
            body: command,
            headers: { 'Idempotency-Key': `${command.providerId}:${command.externalTransactionId}` },
          }),
        ),
      ),
    );
    expect(httpResponses.every((response) => response.status === 200 || response.status === 422)).toBe(true);

    await eventually(betCount, (count) => count === 150);
    await eventually(() => approximateCount(wagerQueues.queueUrl), (count) => count === 0);

    // 1000.00 / 10.00 = 100 apostas cabem; as outras 50 são rejeitadas por saldo
    expect(await scalar(`select count(*) as value from wager_transactions where kind = 'BET' and status = 'PROCESSED'`)).toBe(100);
    expect(
      await scalar(`select count(*) as value from wager_transactions where kind = 'BET' and failure_code = 'INSUFFICIENT_FUNDS'`),
    ).toBe(50);
    await assertFinalInvariant({ balance: '0.00', debits: 100 });
    expect(await approximateCount(wagerQueues.dlqUrl)).toBe(0);

    // Três publishers concorrentes drenam a outbox; cada evento chega com eventId único
    await eventually(pendingOutbox, (pending) => pending === 0);
    const totalEvents = await scalar('select count(*) as value from outbox_messages');
    const published = await publishedEventIds();
    expect(new Set(published).size).toBe(totalEvents);
  });

  test('5 + 8. an instance killed mid-load (after commit, before ack) and a full restart keep the books consistent', async () => {
    instances = await Promise.all([
      spawnInstance('a', 4104, queues()),
      spawnInstance('b', 4105, queues()),
      spawnInstance('c', 4106, queues()),
    ]);

    const commands = Array.from({ length: 90 }, () => wagerCommand(walletId, { playerId: PLAYER, money: { amount: '10.00', currency: 'BRL' } }));
    await Promise.all(
      commands.map((command, i) => sendWagerMessage(wagerQueues.queueUrl, command, { groupId: `crash-${i}-${Math.random()}` })),
    );

    // Mata uma instância com SIGKILL no meio do processamento: mensagens dela podem
    // ter commitado sem ack, e voltam ao SQS quando a visibilidade expira
    await eventually(betCount, (count) => count >= 15);
    await instances[0]!.kill();
    instances = [...instances.slice(1), await spawnInstance('d', 4107, queues())];

    await eventually(betCount, (count) => count === 90);
    await eventually(() => approximateCount(wagerQueues.queueUrl), (count) => count === 0);
    await assertFinalInvariant({ balance: '100.00', debits: 90 });

    // Reinício completo do serviço (§13 item 8): para tudo, sobe de novo e confere
    await Promise.all(instances.map((instance) => instance.stop()));
    instances = [await spawnInstance('restarted', 4108, queues())];

    await eventually(pendingOutbox, (pending) => pending === 0);
    const reconciliation = await call(instances[0]!.baseUrl, 'POST', `/wallets/${walletId}/reconciliation`);
    expect(reconciliation.body).toMatchObject({
      consistent: true,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      checkedEntries: 91,
    });
    await assertFinalInvariant({ balance: '100.00', debits: 90 });
  });
});
