import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { LedgerDirection, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wagering/kinds';
import { MAX_REFERENCE_ATTEMPTS, type WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { settleWagerTransaction, type SettlementInput } from '../../src/domain/wagering/wager-settlement';
import type { Wallet } from '../../src/domain/wallet/wallet';
import { brl, nextId, NOW, openWallet, processed, wager } from './fixtures';

function settle(
  transaction: WagerTransaction,
  wallet: Wallet,
  extra: Partial<Pick<SettlementInput, 'reference' | 'referenceAlreadyReversed'>> = {},
) {
  return settleWagerTransaction({
    transaction,
    wallet,
    reference: extra.reference,
    referenceAlreadyReversed: extra.referenceAlreadyReversed ?? false,
    ledgerEntryId: nextId('entry'),
    at: NOW,
  });
}

function settledBet(wallet: Wallet, amount: string, externalTransactionId = nextId('bet')) {
  const bet = wager(Kind.Bet, amount, { externalTransactionId });
  settle(bet, wallet);
  return bet;
}

describe('settleWagerTransaction', () => {
  describe('BET', () => {
    test('debits the wallet with one DEBIT entry', () => {
      const wallet = openWallet('100.00');
      const bet = wager(Kind.Bet, '25.00');
      const outcome = settle(bet, wallet);

      expect(outcome.status).toBe(Status.Processed);
      expect(outcome.status === Status.Processed && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.toJSON().amount).toBe('75.00');
      expect(bet.status).toBe(Status.Processed);
      expect(bet.resultingBalance?.toJSON().amount).toBe('75.00');
    });

    test('is rejected with INSUFFICIENT_FUNDS and no entry when the balance is not enough', () => {
      const wallet = openWallet('100.00');
      settle(wager(Kind.Bet, '80.00'), wallet);
      const second = wager(Kind.Bet, '80.00');
      const outcome = settle(second, wallet);

      expect(outcome).toEqual({ status: Status.Rejected, failureCode: FailureCode.InsufficientFunds });
      expect(second.status).toBe(Status.Rejected);
      expect(wallet.balance.toJSON().amount).toBe('20.00');
      expect(second.resultingBalance?.toJSON().amount).toBe('20.00');
    });
  });

  describe('WIN', () => {
    test('credits the wallet', () => {
      const wallet = openWallet('100.00');
      const outcome = settle(wager(Kind.Win, '50.00'), wallet);
      expect(outcome.status === Status.Processed && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.toJSON().amount).toBe('150.00');
    });

    test('may reference the BET of the same round', () => {
      const wallet = openWallet('100.00');
      const bet = settledBet(wallet, '10.00');
      const win = wager(Kind.Win, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
      settle(win, wallet, { reference: bet });
      expect(win.status).toBe(Status.Processed);
      expect(win.referenceTransactionId).toBe(bet.id);
    });
  });

  describe('LOSS', () => {
    test('is processed without moving the balance and without a ledger entry', () => {
      const wallet = openWallet('100.00');
      const loss = wager(Kind.Loss, '10.00');
      const outcome = settle(loss, wallet);
      expect(outcome).toEqual({ status: Status.Processed, ledgerEntry: undefined });
      expect(wallet.balance.toJSON().amount).toBe('100.00');
      expect(wallet.version).toBe(1);
      expect(loss.status).toBe(Status.Processed);
    });
  });

  describe('REFUND', () => {
    test('credits back a PROCESSED BET', () => {
      const wallet = openWallet('100.00');
      const bet = settledBet(wallet, '40.00');
      const refund = wager(Kind.Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
      const outcome = settle(refund, wallet, { reference: bet });

      expect(outcome.status === Status.Processed && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.toJSON().amount).toBe('100.00');
      expect(refund.referenceTransactionId).toBe(bet.id);
    });

    test('can only reference a BET', () => {
      const wallet = openWallet('100.00');
      const win = processed(wager(Kind.Win, '10.00'));
      const refund = wager(Kind.Refund, '10.00', { referenceExternalTransactionId: win.externalTransactionId });
      expect(settle(refund, wallet, { reference: win })).toEqual({
        status: Status.Rejected,
        failureCode: FailureCode.ReferenceKindNotAllowed,
      });
    });

    test('is rejected when the BET was already refunded', () => {
      const wallet = openWallet('100.00');
      const bet = settledBet(wallet, '10.00');
      const refund = wager(Kind.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
      expect(settle(refund, wallet, { reference: bet, referenceAlreadyReversed: true })).toEqual({
        status: Status.Rejected,
        failureCode: FailureCode.AlreadyReversed,
      });
      expect(wallet.balance.toJSON().amount).toBe('90.00');
    });

    test('must have the same amount as the BET (no partial reversal)', () => {
      const wallet = openWallet('100.00');
      const bet = settledBet(wallet, '10.00');
      const refund = wager(Kind.Refund, '5.00', { referenceExternalTransactionId: bet.externalTransactionId });
      expect(settle(refund, wallet, { reference: bet })).toEqual({
        status: Status.Rejected,
        failureCode: FailureCode.AmountMismatch,
      });
    });
  });

  describe('ROLLBACK', () => {
    test('of a BET credits the wallet', () => {
      const wallet = openWallet('100.00');
      const bet = settledBet(wallet, '10.00');
      const rollback = wager(Kind.Rollback, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
      const outcome = settle(rollback, wallet, { reference: bet });
      expect(outcome.status === Status.Processed && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.toJSON().amount).toBe('100.00');
    });

    test('of a WIN debits the wallet', () => {
      const wallet = openWallet('100.00');
      const win = wager(Kind.Win, '30.00');
      settle(win, wallet);
      const rollback = wager(Kind.Rollback, '30.00', { referenceExternalTransactionId: win.externalTransactionId });
      const outcome = settle(rollback, wallet, { reference: win });
      expect(outcome.status === Status.Processed && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.toJSON().amount).toBe('100.00');
    });

    test('of a REFUND debits the wallet', () => {
      const wallet = openWallet('100.00');
      const bet = settledBet(wallet, '10.00');
      const refund = wager(Kind.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
      settle(refund, wallet, { reference: bet });
      const rollback = wager(Kind.Rollback, '10.00', { referenceExternalTransactionId: refund.externalTransactionId });
      settle(rollback, wallet, { reference: refund });
      expect(rollback.status).toBe(Status.Processed);
      expect(wallet.balance.toJSON().amount).toBe('90.00');
    });

    test('cannot reference a LOSS or another ROLLBACK', () => {
      const wallet = openWallet('100.00');
      const loss = processed(wager(Kind.Loss, '1.00'));
      const rollback = wager(Kind.Rollback, '1.00', { referenceExternalTransactionId: loss.externalTransactionId });
      expect(settle(rollback, wallet, { reference: loss })).toEqual({
        status: Status.Rejected,
        failureCode: FailureCode.ReferenceKindNotAllowed,
      });
    });

    test('that would make the balance negative is rejected with REVERSAL_WOULD_OVERDRAW', () => {
      const wallet = openWallet('0.00');
      const win = wager(Kind.Win, '50.00');
      settle(win, wallet);
      settle(wager(Kind.Bet, '40.00'), wallet);
      const rollback = wager(Kind.Rollback, '50.00', { referenceExternalTransactionId: win.externalTransactionId });
      const outcome = settle(rollback, wallet, { reference: win });

      expect(outcome).toEqual({ status: Status.Rejected, failureCode: FailureCode.ReversalWouldOverdraw });
      expect(FailureCode.ReversalWouldOverdraw).not.toBe(FailureCode.InsufficientFunds);
      expect(wallet.balance.toJSON().amount).toBe('10.00');
      expect(rollback.status).toBe(Status.Rejected);
    });

    test('is rejected when already rolled back', () => {
      const wallet = openWallet('100.00');
      const bet = settledBet(wallet, '10.00');
      const rollback = wager(Kind.Rollback, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
      expect(settle(rollback, wallet, { reference: bet, referenceAlreadyReversed: true }).status).toBe(Status.Rejected);
    });
  });

  describe('reference resolution', () => {
    test('a missing reference leaves the transaction PENDING_REFERENCE without touching the wallet', () => {
      const wallet = openWallet('100.00');
      const rollback = wager(Kind.Rollback, '10.00', { referenceExternalTransactionId: 'not-arrived-yet' });
      expect(settle(rollback, wallet, { reference: undefined })).toEqual({ status: Status.PendingReference });
      expect(rollback.status).toBe(Status.PendingReference);
      expect(wallet.version).toBe(1);
    });

    test('waits with exponential backoff and is REJECTED with REFERENCE_NOT_FOUND after the attempt limit', () => {
      const wallet = openWallet('100.00');
      const rollback = wager(Kind.Rollback, '10.00', { referenceExternalTransactionId: 'never-arrives' });
      const delays: number[] = [];
      let outcome = settle(rollback, wallet, { reference: undefined });

      for (let attempt = 1; attempt <= MAX_REFERENCE_ATTEMPTS; attempt++) {
        if (outcome.status !== Status.PendingReference) break;
        delays.push((rollback.nextReferenceAttemptAt!.getTime() - NOW.getTime()) / 1000);
        outcome = settle(rollback, wallet, { reference: undefined });
      }

      expect(delays).toEqual([2, 4, 8, 16, 32, 64, 128, 256, 300, 300]);
      expect(outcome).toEqual({ status: Status.Rejected, failureCode: FailureCode.ReferenceNotFound });
      expect(rollback.status).toBe(Status.Rejected);
      expect(rollback.nextReferenceAttemptAt).toBeUndefined();
      expect(wallet.version).toBe(1);
    });

    test('a reference that is itself still pending keeps waiting', () => {
      const wallet = openWallet('100.00');
      const pendingRefund = wager(Kind.Refund, '10.00', { referenceExternalTransactionId: 'bet' });
      pendingRefund.markPendingReference(NOW);
      const rollback = wager(Kind.Rollback, '10.00', {
        referenceExternalTransactionId: pendingRefund.externalTransactionId,
      });
      expect(settle(rollback, wallet, { reference: pendingRefund })).toEqual({ status: Status.PendingReference });
    });

    test('a REJECTED reference cannot be reversed', () => {
      const wallet = openWallet('0.00');
      const bet = wager(Kind.Bet, '10.00');
      settle(bet, wallet);
      const refund = wager(Kind.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
      expect(settle(refund, wallet, { reference: bet })).toEqual({
        status: Status.Rejected,
        failureCode: FailureCode.ReferenceNotProcessed,
      });
    });

    test.each([
      ['providerId', { providerId: 'provider-b' }],
      ['playerId', { playerId: 'other-player' }],
      ['walletId', { walletId: 'other-wallet' }],
      ['roundId', { roundId: 'other-round' }],
    ] as const)('a reference with a different %s is a REFERENCE_MISMATCH', (_field, override) => {
      const wallet = openWallet('100.00');
      const bet = processed(wager(Kind.Bet, '10.00', override));
      const refund = wager(Kind.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
      expect(settle(refund, wallet, { reference: bet })).toEqual({
        status: Status.Rejected,
        failureCode: FailureCode.ReferenceMismatch,
      });
    });

    test('a reference in a different currency is a REFERENCE_MISMATCH', () => {
      const wallet = openWallet('100.00');
      const bet = processed(wager(Kind.Bet, '10.00', { money: Money.from({ amount: '10.00', currency: 'USD' }) }));
      const refund = wager(Kind.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
      expect(settle(refund, wallet, { reference: bet })).toEqual({
        status: Status.Rejected,
        failureCode: FailureCode.ReferenceMismatch,
      });
    });
  });

  describe('wallet ownership and currency', () => {
    test('a transaction in another currency is rejected with CURRENCY_MISMATCH', () => {
      const wallet = openWallet('100.00');
      const bet = wager(Kind.Bet, '10.00', { money: Money.from({ amount: '10.00', currency: 'USD' }) });
      expect(settle(bet, wallet)).toEqual({ status: Status.Rejected, failureCode: FailureCode.CurrencyMismatch });
      expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    });

    test('a transaction for another player is rejected with WALLET_PLAYER_MISMATCH', () => {
      const wallet = openWallet('100.00', { playerId: 'someone-else' });
      expect(settle(wager(Kind.Bet, '10.00'), wallet)).toEqual({
        status: Status.Rejected,
        failureCode: FailureCode.WalletPlayerMismatch,
      });
    });
  });

  test('ledger reconstruction always matches the materialized balance', () => {
    const wallet = openWallet('100.00');
    const entries = [] as { direction: LedgerDirection; money: Money }[];
    const record = (outcome: ReturnType<typeof settle>) => {
      if (outcome.status === Status.Processed && outcome.ledgerEntry) entries.push(outcome.ledgerEntry);
    };

    const bet = wager(Kind.Bet, '30.00');
    record(settle(bet, wallet));
    record(settle(wager(Kind.Win, '45.50', { referenceExternalTransactionId: bet.externalTransactionId }), wallet, { reference: bet }));
    record(settle(wager(Kind.Bet, '500.00'), wallet));
    record(settle(wager(Kind.Loss, '5.00'), wallet));

    const rebuilt = entries.reduce(
      (balance, entry) => (entry.direction === LedgerDirection.Credit ? balance.add(entry.money) : balance.subtract(entry.money)),
      brl('100.00'),
    );
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.toJSON().amount).toBe('115.50');
  });
});
