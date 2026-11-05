import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { noopMetrics } from '../../src/application/ports/metrics';
import { silentLogger } from '../../src/application/ports/observability';
import type { Clock } from '../../src/application/ports/system';
import { PendingReferenceProcessor } from '../../src/application/wagering/pending-reference-processor';
import { MAX_REFERENCE_ATTEMPTS } from '../../src/domain/wagering/wager-transaction';
import { MikroOrmPendingReferenceRepository } from '../../src/infrastructure/persistence/mikro-orm-pending-reference-repository';
import { createTestOrm, resetDatabase, sql } from '../helpers/database';
import { buildUseCases, keyOf, wagerCommand, walletConsistency } from '../helpers/wagering';

let orm: MikroORM;
let now: Date;
const clock: Clock = { now: () => now };
let useCases: ReturnType<typeof buildUseCases>;
let processor: PendingReferenceProcessor;
let walletId: string;

const advance = (seconds: number) => (now = new Date(now.getTime() + seconds * 1000));

async function submit(overrides: Parameters<typeof wagerCommand>[1] = {}) {
  const command = wagerCommand(walletId, overrides);
  return { command, result: await useCases.processWager.execute(command, { idempotencyKey: keyOf(command), correlationId: 'c' }) };
}

async function transactionRow(id: string) {
  const [row] = await sql<{ status: string; failure_code: string | null; reference_attempts: number }>(
    orm,
    'select status, failure_code, reference_attempts from wager_transactions where id = ?',
    [id],
  );
  return row;
}

async function eventTypesFor(aggregateId: string): Promise<string[]> {
  const rows = await sql<{ event_type: string }>(
    orm,
    'select event_type from outbox_messages where aggregate_id = ? order by occurred_at, event_type',
    [aggregateId],
  );
  return rows.map((row) => row.event_type);
}

beforeAll(async () => {
  orm = await createTestOrm();
});

afterAll(async () => {
  await orm.close(true);
});

beforeEach(async () => {
  await resetDatabase(orm);
  now = new Date('2026-07-29T15:00:00.000Z');
  useCases = buildUseCases(orm, clock);
  processor = new PendingReferenceProcessor(
    new MikroOrmPendingReferenceRepository(orm),
    useCases.processWager,
    clock,
    { batchSize: 50, leaseMs: 30_000 },
    noopMetrics,
    silentLogger,
  );
  walletId = (
    await useCases.createWallet.execute({ playerId: 'player-1', initialBalance: { amount: '100.00', currency: 'BRL' } }, 'c')
  ).id;
});

describe('pending reference worker', () => {
  test('ROLLBACK delivered before its BET is applied once the BET arrives', async () => {
    const betExternalId = 'bet-late';
    const rollback = await submit({
      kind: 'ROLLBACK',
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternalId,
    });
    expect(String(rollback.result.status)).toBe('PENDING_REFERENCE');

    // Antes do vencimento, nada é reprocessado
    advance(1);
    expect(await processor.processDue()).toBe(0);

    await submit({ externalTransactionId: betExternalId, money: { amount: '30.00', currency: 'BRL' } });
    expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '70.00' });

    advance(2);
    expect(await processor.processDue()).toBe(1);

    expect(await transactionRow(rollback.result.transactionId)).toMatchObject({ status: 'PROCESSED' });
    expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '100.00', rebuilt: '100.00', entries: 3 });
    expect(await eventTypesFor(rollback.result.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
    ]);

    // A transação já resolvida não volta a ser reivindicada
    advance(600);
    expect(await processor.processDue()).toBe(0);
  });

  test('REFUND delivered before its BET is applied, and its replay returns the final result', async () => {
    const refund = await submit({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1' });
    await submit({ externalTransactionId: 'bet-1' });
    advance(2);
    await processor.processDue();

    expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '100.00', rebuilt: '100.00' });
    const replay = await useCases.processWager.execute(refund.command, { idempotencyKey: keyOf(refund.command), correlationId: 'c' });
    expect(replay).toMatchObject({ status: 'PROCESSED', idempotentReplay: true, balance: { amount: '100.00' } });
  });

  test('a reference that never arrives is REJECTED with REFERENCE_NOT_FOUND after the limit, with its event', async () => {
    const rollback = await submit({ kind: 'ROLLBACK', referenceExternalTransactionId: 'never' });

    let processed = 0;
    for (let i = 0; i < MAX_REFERENCE_ATTEMPTS + 2; i++) {
      advance(301);
      processed += await processor.processDue();
    }

    expect(processed).toBe(MAX_REFERENCE_ATTEMPTS);
    expect(await transactionRow(rollback.result.transactionId)).toEqual({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      reference_attempts: MAX_REFERENCE_ATTEMPTS - 1,
    });
    expect(await eventTypesFor(rollback.result.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '100.00', version: 1 });
  });

  test('concurrent workers never reprocess the same pending transaction twice', async () => {
    const pendings = await Promise.all(
      Array.from({ length: 10 }, (_, i) => submit({ kind: 'REFUND', referenceExternalTransactionId: `bet-${i}` })),
    );
    for (let i = 0; i < 10; i++) {
      await submit({ externalTransactionId: `bet-${i}`, money: { amount: '1.00', currency: 'BRL' } });
    }
    advance(2);

    const repository = new MikroOrmPendingReferenceRepository(orm);
    const [first, second] = await Promise.all([repository.claimDue(now, 30_000, 10), repository.claimDue(now, 30_000, 10)]);
    expect(first.length + second.length).toBe(10);
    expect(new Set([...first, ...second]).size).toBe(10);
    expect(pendings).toHaveLength(10);
  });
});
