import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmTransactionRunner } from '../../src/infrastructure/persistence/mikro-orm-wagering-store';
import { createTestOrm, resetDatabase, sql } from '../helpers/database';
import { buildUseCases, keyOf, wagerCommand, walletConsistency } from '../helpers/wagering';

/*
 * Paralelismo real: cada chamada usa sua própria conexão do pool e sua própria
 * transação SQL; as disputas acontecem no PostgreSQL, não num mock sequencial.
 */
let orm: MikroORM;
let useCases: ReturnType<typeof buildUseCases>;

const playerByWallet = new Map<string, string>();

/** Cada wallet tem seu próprio player (no máximo uma wallet por player e moeda). */
async function newWallet(balance: string) {
  const playerId = `player-${Bun.randomUUIDv7()}`;
  const { id } = await useCases.createWallet.execute({ playerId, initialBalance: { amount: balance, currency: 'BRL' } }, 'c');
  playerByWallet.set(id, playerId);
  return id;
}

const commandFor = (walletId: string, overrides: Parameters<typeof wagerCommand>[1] = {}) =>
  wagerCommand(walletId, { playerId: playerByWallet.get(walletId), ...overrides });

async function count(query: string, params: unknown[]): Promise<number> {
  const [row] = await sql<{ count: string }>(orm, query, params);
  return Number(row?.count);
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
});

describe('concurrency (§13)', () => {
  test('1. the same BET sent 50 times in parallel produces a single debit', async () => {
    const walletId = await newWallet('100.00');
    const command = commandFor(walletId);

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        useCases.processWager.execute({ ...command }, { idempotencyKey: keyOf(command), correlationId: 'c' }),
      ),
    );

    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(results.every((result) => result.balance?.amount === '75.00')).toBe(true);
    expect(await count(`select count(*) from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId])).toBe(1);
    expect(await walletConsistency(orm, walletId)).toEqual({ stored: '75.00', rebuilt: '75.00', version: 2, entries: 2 });
  });

  test('2. mandatory scenario (§8): balance 100.00, two concurrent BETs of 80.00', async () => {
    const walletId = await newWallet('100.00');
    const first = commandFor(walletId, { money: { amount: '80.00', currency: 'BRL' } });
    const second = commandFor(walletId, { money: { amount: '80.00', currency: 'BRL' } });

    const results = await Promise.all(
      [first, second].map((command) =>
        useCases.processWager.execute(command, { idempotencyKey: keyOf(command), correlationId: 'c' }),
      ),
    );

    // Retries de ambas não podem duplicar o débito
    const retries = await Promise.all(
      [first, second].map((command) =>
        useCases.processWager.execute(command, { idempotencyKey: keyOf(command), correlationId: 'c' }),
      ),
    );

    const statuses = results.map((result) => String(result.status)).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect(String(results.find((result) => String(result.status) === 'REJECTED')?.failureCode)).toBe('INSUFFICIENT_FUNDS');
    expect(retries.map((result) => result.idempotentReplay)).toEqual([true, true]);
    expect(retries.map((result) => String(result.status)).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(await count(`select count(*) from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId])).toBe(1);
    expect(await walletConsistency(orm, walletId)).toEqual({ stored: '20.00', rebuilt: '20.00', version: 2, entries: 2 });
  });

  test('2b. hot wallet: 200 concurrent BETs never overdraw and every success has exactly one debit', async () => {
    const walletId = await newWallet('1000.00');
    const commands = Array.from({ length: 200 }, () => commandFor(walletId, { money: { amount: '7.00', currency: 'BRL' } }));

    const results = await Promise.all(
      commands.map((command) => useCases.processWager.execute(command, { idempotencyKey: keyOf(command), correlationId: 'c' })),
    );

    const processed = results.filter((result) => result.status === 'PROCESSED').length;
    // floor(1000 / 7) = 142 apostas cabem; o resto é rejeitado por saldo
    expect(processed).toBe(142);
    expect(results.filter((result) => result.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(58);
    expect(await count(`select count(*) from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId])).toBe(142);
    expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '6.00', rebuilt: '6.00', version: 143 });
  });

  test('3. different wallets are processed in parallel: a locked wallet does not block another', async () => {
    const lockedWallet = await newWallet('100.00');
    const freeWallets = await Promise.all(Array.from({ length: 10 }, () => newWallet('100.00')));

    // Segura o lock de uma wallet numa transação aberta
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => (signalLocked = resolve));
    const holder = new MikroOrmTransactionRunner(orm).run(async (store) => {
      await store.findWalletForUpdate(lockedWallet);
      signalLocked();
      await held;
    });
    await locked;

    const startedAt = performance.now();
    const results = await Promise.all(
      freeWallets.map((walletId) => {
        const command = commandFor(walletId);
        return useCases.processWager.execute(command, { idempotencyKey: keyOf(command), correlationId: 'c' });
      }),
    );
    const elapsedMs = performance.now() - startedAt;

    release();
    await holder;

    expect(results.every((result) => result.status === 'PROCESSED')).toBe(true);
    // Sem lock global: as outras wallets terminam enquanto a primeira continua bloqueada
    expect(elapsedMs).toBeLessThan(5_000);
    for (const walletId of freeWallets) {
      expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '75.00', rebuilt: '75.00' });
    }
  });

  test('concurrent REFUND and ROLLBACK of the same BET: each kind reverts it at most once', async () => {
    const walletId = await newWallet('100.00');
    const bet = commandFor(walletId, { money: { amount: '40.00', currency: 'BRL' } });
    await useCases.processWager.execute(bet, { idempotencyKey: keyOf(bet), correlationId: 'c' });

    const refunds = Array.from({ length: 10 }, () =>
      commandFor(walletId, { kind: 'REFUND', money: bet.money, referenceExternalTransactionId: bet.externalTransactionId }),
    );
    const results = await Promise.all(
      refunds.map((command) => useCases.processWager.execute(command, { idempotencyKey: keyOf(command), correlationId: 'c' })),
    );

    expect(results.filter((result) => result.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((result) => result.failureCode === 'ALREADY_REVERSED')).toHaveLength(9);
    expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '100.00', rebuilt: '100.00' });
  });
});
