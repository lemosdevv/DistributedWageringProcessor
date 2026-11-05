import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError } from '../../src/application/ports/wagering-store';
import { WalletBalanceChanged } from '../../src/domain/events/wallet-balance-changed';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { Money } from '../../src/domain/money/money';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wagering/kinds';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';
import { MikroOrmTransactionRunner } from '../../src/infrastructure/persistence/mikro-orm-wagering-store';
import { createTestOrm, resetDatabase, sql } from '../helpers/database';

let orm: MikroORM;
let runner: MikroOrmTransactionRunner;

const id = () => Bun.randomUUIDv7();
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-07-29T15:00:00.000Z');

function newWallet(balance = '100.00') {
  return Wallet.open({
    id: id(),
    playerId: 'player-1',
    initialBalance: brl(balance),
    openingTransactionId: id(),
    openingLedgerEntryId: id(),
    at,
  }).wallet;
}

function newBet(walletId: string, amount = '25.00') {
  const external = `tx-${id()}`;
  return WagerTransaction.create({
    id: id(),
    providerId: 'provider-a',
    externalTransactionId: external,
    idempotencyKey: `provider-a:${external}`,
    payloadHash: 'hash',
    walletId,
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: Kind.Bet,
    money: brl(amount),
    referenceExternalTransactionId: undefined,
    createdAt: at,
  });
}

beforeAll(async () => {
  orm = await createTestOrm();
  runner = new MikroOrmTransactionRunner(orm);
});

afterAll(async () => {
  await orm.close(true);
});

beforeEach(async () => {
  await resetDatabase(orm);
});

describe('MikroOrmWageringStore', () => {
  test('round-trips a wallet keeping exact decimals', async () => {
    const wallet = newWallet('0.30');
    await runner.run((store) => store.addWallet(wallet));
    const loaded = await runner.run((store) => store.findWallet(wallet.id));
    expect(loaded?.balance.toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    expect(loaded?.version).toBe(1);
    expect(loaded?.playerId).toBe('player-1');
  });

  test('round-trips a transaction, its state changes and the ledger entry', async () => {
    const wallet = newWallet();
    const bet = newBet(wallet.id);
    await runner.run(async (store) => {
      await store.addWallet(wallet);
      await store.addTransaction(bet);
    });

    await runner.run(async (store) => {
      const locked = (await store.findWalletForUpdate(wallet.id))!;
      const expectedVersion = locked.version;
      const entry = locked.debit({ money: bet.money, transactionId: bet.id, ledgerEntryId: id(), at });
      bet.markProcessed(undefined, at, locked.balance);
      await store.updateWalletBalance(locked, expectedVersion);
      await store.updateTransaction(bet);
      await store.addLedgerEntry(entry);
    });

    const loaded = await runner.run((store) => store.findTransactionByIdempotencyKey(bet.idempotencyKey));
    expect(loaded?.status).toBe(Status.Processed);
    expect(loaded?.resultingBalance?.toJSON().amount).toBe('75.00');
    expect(loaded?.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect((await runner.run((store) => store.findWallet(wallet.id)))?.version).toBe(2);
    expect(await runner.run((store) => store.findTransactionByExternalId('provider-a', bet.externalTransactionId))).toBeDefined();
  });

  test('stores a rejected transaction with its failure code', async () => {
    const wallet = newWallet();
    const bet = newBet(wallet.id);
    bet.reject(FailureCode.InsufficientFunds, at, wallet.balance);
    await runner.run(async (store) => {
      await store.addWallet(wallet);
      await store.addTransaction(bet);
    });
    const loaded = await runner.run((store) => store.findTransactionById(bet.id));
    expect(loaded?.status).toBe(Status.Rejected);
    expect(loaded?.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('updateWalletBalance refuses a stale version', async () => {
    const wallet = newWallet();
    await runner.run((store) => store.addWallet(wallet));
    wallet.credit({ money: brl('1.00'), transactionId: id(), ledgerEntryId: id(), at });
    await expect(runner.run((store) => store.updateWalletBalance(wallet, 99))).rejects.toThrow(ConcurrencyConflictError);
  });

  test('detects processed reversals per kind', async () => {
    const wallet = newWallet();
    const bet = newBet(wallet.id);
    bet.markProcessed(undefined, at, wallet.balance);
    const refund = WagerTransaction.create({
      ...{ id: id(), providerId: 'provider-a', externalTransactionId: 'refund-1', idempotencyKey: 'provider-a:refund-1' },
      payloadHash: 'h',
      walletId: wallet.id,
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'g',
      kind: Kind.Refund,
      money: brl('25.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
      createdAt: at,
    });
    refund.markProcessed(bet.id, at, wallet.balance);

    await runner.run(async (store) => {
      await store.addWallet(wallet);
      await store.addTransaction(bet);
      await store.addTransaction(refund);
    });

    expect(await runner.run((store) => store.hasProcessedReversal(bet.id, Kind.Refund))).toBe(true);
    expect(await runner.run((store) => store.hasProcessedReversal(bet.id, Kind.Rollback))).toBe(false);
  });

  test('stores inbox and outbox messages', async () => {
    const wallet = newWallet();
    const entry = wallet.credit({ money: brl('1.00'), transactionId: id(), ledgerEntryId: id(), at });
    const outbox = OutboxMessage.enqueue(
      WalletBalanceChanged.from(wallet, entry, { eventId: id(), correlationId: 'c', occurredAt: at }),
    );
    await runner.run(async (store) => {
      await store.addInboxMessage(InboxMessage.receive({ messageId: 'msg-1', consumerName: 'c', payloadHash: 'h', receivedAt: at }));
      await store.addOutboxMessages([outbox]);
    });

    expect(await runner.run((store) => store.findInboxMessage('c', 'msg-1'))).toBeDefined();
    const [row] = await sql<{ payload: { data: { money: unknown } } }>(orm, 'select payload from outbox_messages');
    expect(row?.payload.data.money).toEqual({ amount: '1.00', currency: 'BRL' });
  });

  test('everything written in a failed run is rolled back', async () => {
    const wallet = newWallet();
    await expect(
      runner.run(async (store) => {
        await store.addWallet(wallet);
        throw new Error('boom after write');
      }),
    ).rejects.toThrow('boom after write');
    expect(await runner.run((store) => store.findWallet(wallet.id))).toBeUndefined();
  });

  test('findWalletForUpdate blocks a second locker until the first commits', async () => {
    const wallet = newWallet();
    await runner.run((store) => store.addWallet(wallet));

    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstHoldsLock = new Promise<void>((resolve) => (releaseFirst = resolve));
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => (signalLocked = resolve));

    const first = runner.run(async (store) => {
      await store.findWalletForUpdate(wallet.id);
      events.push('first-locked');
      signalLocked();
      await firstHoldsLock;
      events.push('first-commit');
    });

    await locked;
    const second = runner.run(async (store) => {
      await store.findWalletForUpdate(wallet.id);
      events.push('second-locked');
    });

    await Bun.sleep(150);
    events.push('release');
    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(['first-locked', 'release', 'first-commit', 'second-locked']);
  });
});
