import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { IdempotencyConflictError, InvalidPayloadError, WalletNotFoundError } from '../../src/application/errors';
import type { TransactionRunner } from '../../src/application/ports/wagering-store';
import { uuidV7Generator } from '../../src/application/ports/system';
import { ProcessWagerTransactionUseCase } from '../../src/application/wagering/process-wager-transaction.use-case';
import { WalletAlreadyExistsError } from '../../src/application/wallets/create-wallet.use-case';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { WagerTransactionStatus as Status } from '../../src/domain/wagering/kinds';
import { createTestOrm, resetDatabase, sql } from '../helpers/database';
import { buildUseCases, keyOf, wagerCommand, walletConsistency } from '../helpers/wagering';

let orm: MikroORM;
let useCases: ReturnType<typeof buildUseCases>;
let walletId: string;

const ctx = (key: string) => ({ idempotencyKey: key, correlationId: `corr-${key}` });

async function submit(overrides: Parameters<typeof wagerCommand>[1] = {}) {
  const command = wagerCommand(walletId, overrides);
  return { command, result: await useCases.processWager.execute(command, ctx(keyOf(command))) };
}

async function outboxTypes(): Promise<string[]> {
  const rows = await sql<{ event_type: string }>(orm, 'select event_type from outbox_messages order by occurred_at, event_type');
  return rows.map((row) => row.event_type);
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
  const wallet = await useCases.createWallet.execute(
    { playerId: 'player-1', initialBalance: { amount: '100.00', currency: 'BRL' } },
    'test',
  );
  walletId = wallet.id;
});

describe('CreateWallet', () => {
  test('creates the OPENING transaction and CREDIT entry in the same SQL transaction', async () => {
    const wallet = await useCases.createWallet.execute(
      { playerId: 'player-2', initialBalance: { amount: '1000.00', currency: 'BRL' } },
      'test',
    );
    expect(wallet).toMatchObject({ playerId: 'player-2', balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    const [opening] = await sql<{ kind: string; status: string }>(
      orm,
      'select kind, status from wager_transactions where wallet_id = ?',
      [wallet.id],
    );
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED' });
    expect(await walletConsistency(orm, wallet.id)).toEqual({ stored: '1000.00', rebuilt: '1000.00', version: 1, entries: 1 });
  });

  test('a zero initial balance creates no OPENING', async () => {
    const wallet = await useCases.createWallet.execute(
      { playerId: 'player-3', initialBalance: { amount: '0.00', currency: 'BRL' } },
      'test',
    );
    expect(await walletConsistency(orm, wallet.id)).toEqual({ stored: '0.00', rebuilt: '0.00', version: 1, entries: 0 });
  });

  test('a duplicate wallet for the same player and currency is a conflict', async () => {
    await expect(
      useCases.createWallet.execute({ playerId: 'player-1', initialBalance: { amount: '1.00', currency: 'BRL' } }, 'test'),
    ).rejects.toThrow(WalletAlreadyExistsError);
    await useCases.createWallet.execute({ playerId: 'player-1', initialBalance: { amount: '1.00', currency: 'USD' } }, 'test');
  });
});

describe('ProcessWagerTransaction', () => {
  test('BET debits, writes one ledger entry and the outbox events in one commit', async () => {
    const { result } = await submit();
    expect(result).toMatchObject({
      status: Status.Processed,
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await walletConsistency(orm, walletId)).toEqual({ stored: '75.00', rebuilt: '75.00', version: 2, entries: 2 });
    expect(await outboxTypes()).toContain('WalletBalanceChanged');
    expect(await outboxTypes()).toContain('WagerTransactionProcessed');
  });

  test('BET without funds is REJECTED with INSUFFICIENT_FUNDS and no ledger entry', async () => {
    const { result } = await submit({ money: { amount: '100.01', currency: 'BRL' } });
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.InsufficientFunds });
    expect(result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(await walletConsistency(orm, walletId)).toEqual({ stored: '100.00', rebuilt: '100.00', version: 1, entries: 1 });
    const types = await outboxTypes();
    expect(types.filter((type) => type === 'WagerTransactionRejected')).toHaveLength(1);
  });

  test('LOSS is processed without ledger and without WalletBalanceChanged', async () => {
    await sql(orm, 'delete from outbox_messages');
    const { result } = await submit({ kind: 'LOSS' });
    expect(result.status).toBe(Status.Processed);
    expect(await outboxTypes()).toEqual(['WagerTransactionProcessed']);
    expect((await walletConsistency(orm, walletId)).entries).toBe(1);
  });

  test('WIN credits and can reference the BET of the round', async () => {
    const bet = await submit();
    const { result } = await submit({
      kind: 'WIN',
      money: { amount: '60.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.command.externalTransactionId,
    });
    expect(result).toMatchObject({ status: Status.Processed, balance: { amount: '135.00', currency: 'BRL' } });
  });

  test('REFUND reverts a BET once; a second REFUND is ALREADY_REVERSED', async () => {
    const bet = await submit();
    const refund = await submit({ kind: 'REFUND', referenceExternalTransactionId: bet.command.externalTransactionId });
    expect(refund.result).toMatchObject({ status: Status.Processed, balance: { amount: '100.00', currency: 'BRL' } });

    const second = await submit({ kind: 'REFUND', referenceExternalTransactionId: bet.command.externalTransactionId });
    expect(second.result).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.AlreadyReversed });
    expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '100.00', rebuilt: '100.00' });
  });

  test('ROLLBACK of BET, WIN and REFUND apply the inverse direction', async () => {
    const bet = await submit({ money: { amount: '10.00', currency: 'BRL' } });
    const win = await submit({ kind: 'WIN', money: { amount: '30.00', currency: 'BRL' } });
    const rollbackWin = await submit({
      kind: 'ROLLBACK',
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: win.command.externalTransactionId,
    });
    expect(rollbackWin.result.balance).toEqual({ amount: '90.00', currency: 'BRL' });

    const refund = await submit({
      kind: 'REFUND',
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.command.externalTransactionId,
    });
    expect(refund.result.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const rollbackRefund = await submit({
      kind: 'ROLLBACK',
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: refund.command.externalTransactionId,
    });
    expect(rollbackRefund.result.balance).toEqual({ amount: '90.00', currency: 'BRL' });

    const rollbackBet = await submit({
      kind: 'ROLLBACK',
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.command.externalTransactionId,
    });
    expect(rollbackBet.result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '100.00', rebuilt: '100.00' });
  });

  test('a reversal that would overdraw is REJECTED with REVERSAL_WOULD_OVERDRAW', async () => {
    const win = await submit({ kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } });
    await submit({ money: { amount: '120.00', currency: 'BRL' } });
    const { result } = await submit({
      kind: 'ROLLBACK',
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: win.command.externalTransactionId,
    });
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReversalWouldOverdraw });
    expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '30.00', rebuilt: '30.00' });
  });

  test('a reference from another round is REFERENCE_MISMATCH and a partial amount is AMOUNT_MISMATCH', async () => {
    const bet = await submit();
    const otherRound = await submit({
      kind: 'REFUND',
      roundId: 'another-round',
      referenceExternalTransactionId: bet.command.externalTransactionId,
    });
    expect(otherRound.result.failureCode).toBe(FailureCode.ReferenceMismatch);

    const partial = await submit({
      kind: 'REFUND',
      money: { amount: '5.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.command.externalTransactionId,
    });
    expect(partial.result.failureCode).toBe(FailureCode.AmountMismatch);
  });

  test('a missing reference is persisted as PENDING_REFERENCE with its event', async () => {
    const { result } = await submit({ kind: 'ROLLBACK', referenceExternalTransactionId: 'not-yet' });
    expect(result).toMatchObject({ status: Status.PendingReference, balance: undefined });
    expect(await outboxTypes()).toContain('WagerTransactionPendingReference');
    expect((await walletConsistency(orm, walletId)).version).toBe(1);
  });

  test('a currency different from the wallet is REJECTED with CURRENCY_MISMATCH', async () => {
    const { result } = await submit({ money: { amount: '1.00', currency: 'USD' } });
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.CurrencyMismatch });
  });

  describe('idempotency', () => {
    test('an identical request is a replay with the original result and balance', async () => {
      const command = wagerCommand(walletId);
      const first = await useCases.processWager.execute(command, ctx(keyOf(command)));
      await submit({ money: { amount: '5.00', currency: 'BRL' } });

      const replay = await useCases.processWager.execute({ ...command }, ctx(keyOf(command)));
      expect(replay).toEqual({ ...first, idempotentReplay: true });
      expect(replay.balance).toEqual({ amount: '75.00', currency: 'BRL' });
      expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '70.00', rebuilt: '70.00', entries: 3 });
    });

    test('"25" and "25.00" are the same payload', async () => {
      const command = wagerCommand(walletId);
      await useCases.processWager.execute(command, ctx(keyOf(command)));
      const replay = await useCases.processWager.execute(
        { ...command, money: { amount: '25', currency: 'BRL' } },
        ctx(keyOf(command)),
      );
      expect(replay.idempotentReplay).toBe(true);
    });

    test('the same key with a different payload is a conflict, not a replay', async () => {
      const command = wagerCommand(walletId);
      await useCases.processWager.execute(command, ctx(keyOf(command)));
      await expect(
        useCases.processWager.execute({ ...command, money: { amount: '26.00', currency: 'BRL' } }, ctx(keyOf(command))),
      ).rejects.toThrow(IdempotencyConflictError);
      expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '75.00', entries: 2 });
    });

    test('the same provider operation under another key is a conflict', async () => {
      const command = wagerCommand(walletId);
      await useCases.processWager.execute(command, ctx(keyOf(command)));
      await expect(useCases.processWager.execute(command, ctx('another-key'))).rejects.toThrow(IdempotencyConflictError);
    });

    test('a REJECTED transaction replays as REJECTED even after funds arrive', async () => {
      const command = wagerCommand(walletId, { money: { amount: '150.00', currency: 'BRL' } });
      const first = await useCases.processWager.execute(command, ctx(keyOf(command)));
      await submit({ kind: 'WIN', money: { amount: '500.00', currency: 'BRL' } });
      const replay = await useCases.processWager.execute(command, ctx(keyOf(command)));
      expect(replay).toEqual({ ...first, idempotentReplay: true });
      expect(replay.failureCode).toBe(FailureCode.InsufficientFunds);
    });
  });

  describe('inbox', () => {
    test('a redelivered message is deduplicated by (consumer, messageId)', async () => {
      const command = wagerCommand(walletId);
      const inboxCtx = { ...ctx(keyOf(command)), inbox: { consumerName: 'wager-consumer', messageId: 'msg-1' } };
      const first = await useCases.processWager.execute(command, inboxCtx);
      const redelivery = await useCases.processWager.execute(command, inboxCtx);
      expect(redelivery).toEqual({ ...first, idempotentReplay: true });
      const [inbox] = await sql<{ count: string }>(orm, 'select count(*) from inbox_messages');
      expect(Number(inbox?.count)).toBe(1);
      expect(await walletConsistency(orm, walletId)).toMatchObject({ stored: '75.00', entries: 2 });
    });
  });

  describe('invalid input', () => {
    test.each([
      [{ money: { amount: '1e2', currency: 'BRL' } }, FailureCode.InvalidPayload],
      [{ money: { amount: '-5.00', currency: 'BRL' } }, FailureCode.InvalidPayload],
      [{ kind: 'OPENING' }, FailureCode.InternalKindNotAllowed],
      [{ kind: 'JACKPOT' }, FailureCode.InvalidPayload],
      [{ kind: 'REFUND' }, FailureCode.InvalidPayload],
    ] as const)('%p is rejected as invalid payload without persisting', async (override, code) => {
      const error = await submit(override as never).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(InvalidPayloadError);
      expect((error as InvalidPayloadError).failureCode).toBe(code);
      const [row] = await sql<{ count: string }>(orm, `select count(*) from wager_transactions where kind <> 'OPENING'`);
      expect(Number(row?.count)).toBe(0);
    });

    test('an unknown wallet is WALLET_NOT_FOUND', async () => {
      walletId = Bun.randomUUIDv7();
      await expect(submit()).rejects.toThrow(WalletNotFoundError);
    });
  });

  test('atomicity: a failure after the ledger write rolls back wallet, transaction, ledger and outbox', async () => {
    const realRunner = useCases.runner;
    const failingRunner: TransactionRunner = {
      run: (work) =>
        realRunner.run(async (store) => {
          // Injeta falha na gravação da outbox, depois de saldo, transação e ledger
          const sabotaged = Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
            addOutboxMessages: async () => {
              throw new Error('outbox unavailable');
            },
          });
          return work(sabotaged);
        }),
    };
    const useCase = new ProcessWagerTransactionUseCase(failingRunner, { now: () => new Date() }, uuidV7Generator);
    const command = wagerCommand(walletId);
    await expect(useCase.execute(command, ctx(keyOf(command)))).rejects.toThrow('outbox unavailable');

    expect(await walletConsistency(orm, walletId)).toEqual({ stored: '100.00', rebuilt: '100.00', version: 1, entries: 1 });
    const [row] = await sql<{ count: string }>(orm, 'select count(*) from wager_transactions where external_transaction_id = ?', [
      command.externalTransactionId,
    ]);
    expect(Number(row?.count)).toBe(0);
  });
});
