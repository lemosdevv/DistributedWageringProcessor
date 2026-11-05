import { describe, expect, test } from 'bun:test';
import { InvalidAmountError, InvalidTransactionStateError, InvalidWagerTransactionError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { LedgerDirection, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wagering/kinds';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { brl, NOW, processed, wager } from './fixtures';

describe('WagerTransaction', () => {
  describe('create', () => {
    test('is born PENDING', () => {
      expect(wager(Kind.Bet, '10.00').status).toBe(Status.Pending);
    });

    test('rejects OPENING from providers', () => {
      expect(() => wager(Kind.Opening, '10.00')).toThrow(InvalidWagerTransactionError);
      try {
        wager(Kind.Opening, '10.00');
      } catch (error) {
        expect((error as InvalidWagerTransactionError).code).toBe(FailureCode.InternalKindNotAllowed);
      }
    });

    test.each([Kind.Refund, Kind.Rollback])('%s requires referenceExternalTransactionId', (kind) => {
      expect(() => wager(kind, '10.00')).toThrow(InvalidWagerTransactionError);
      expect(wager(kind, '10.00', { referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(true);
    });

    test.each([Kind.Bet, Kind.Win, Kind.Refund])('%s rejects a zero amount', (kind) => {
      expect(() => wager(kind, '0.00', { referenceExternalTransactionId: 'x' })).toThrow(InvalidAmountError);
    });

    test('LOSS accepts a zero amount because it never moves the balance', () => {
      expect(wager(Kind.Loss, '0.00').affectsBalance()).toBe(false);
    });

    test('createOpening is internal and already PROCESSED', () => {
      const opening = WagerTransaction.createOpening({
        id: 'o',
        walletId: 'w',
        playerId: 'p',
        money: brl('1000.00'),
        createdAt: NOW,
      });
      expect(opening.kind).toBe(Kind.Opening);
      expect(opening.status).toBe(Status.Processed);
      expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });
  });

  describe('transitions', () => {
    test('PENDING → PENDING_REFERENCE → PROCESSED', () => {
      const tx = wager(Kind.Refund, '10.00', { referenceExternalTransactionId: 'bet' });
      tx.markPendingReference();
      tx.markPendingReference();
      expect(tx.status).toBe(Status.PendingReference);
      tx.markProcessed('ref-id', NOW, brl('10.00'));
      expect(tx.status).toBe(Status.Processed);
      expect(tx.referenceTransactionId).toBe('ref-id');
      expect(tx.processedAt).toEqual(NOW);
      expect(tx.resultingBalance?.toJSON().amount).toBe('10.00');
    });

    test('reject stores the failure code and the observed balance', () => {
      const tx = wager(Kind.Bet, '10.00');
      tx.reject(FailureCode.InsufficientFunds, NOW, brl('5.00'));
      expect(tx.status).toBe(Status.Rejected);
      expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(tx.resultingBalance?.toJSON().amount).toBe('5.00');
    });

    const terminalFactories = {
      PROCESSED: (tx: WagerTransaction) => tx.markProcessed(undefined, NOW, brl('1.00')),
      REJECTED: (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds, NOW, brl('1.00')),
      FAILED: (tx: WagerTransaction) => tx.fail(FailureCode.InvalidPayload, NOW),
    };

    for (const [terminal, reach] of Object.entries(terminalFactories)) {
      test(`${terminal} is terminal: every transition throws`, () => {
        const tx = wager(Kind.Bet, '10.00');
        reach(tx);
        expect(tx.isTerminal()).toBe(true);
        expect(() => tx.markProcessed(undefined, NOW, brl('1.00'))).toThrow(InvalidTransactionStateError);
        expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
        expect(() => tx.reject(FailureCode.InsufficientFunds, NOW, undefined)).toThrow(InvalidTransactionStateError);
        expect(() => tx.fail(FailureCode.InvalidPayload, NOW)).toThrow(InvalidTransactionStateError);
      });
    }
  });

  describe('domain queries', () => {
    test('affectsBalance is false only for LOSS', () => {
      expect(wager(Kind.Loss, '1.00').affectsBalance()).toBe(false);
      expect(wager(Kind.Bet, '1.00').affectsBalance()).toBe(true);
      expect(wager(Kind.Win, '1.00').affectsBalance()).toBe(true);
    });

    test('requiresReference only for REFUND and ROLLBACK', () => {
      expect(wager(Kind.Bet, '1.00').requiresReference()).toBe(false);
      expect(wager(Kind.Win, '1.00').requiresReference()).toBe(false);
      expect(wager(Kind.Loss, '1.00').requiresReference()).toBe(false);
    });

    test('matchesPayload distinguishes divergent payloads for the same idempotency key', () => {
      const tx = wager(Kind.Bet, '1.00', { payloadHash: 'abc' });
      expect(tx.matchesPayload('abc')).toBe(true);
      expect(tx.matchesPayload('abd')).toBe(false);
    });

    test('ledger direction by kind', () => {
      const bet = processed(wager(Kind.Bet, '10.00'));
      const win = processed(wager(Kind.Win, '10.00'));
      const refund = processed(wager(Kind.Refund, '10.00', { referenceExternalTransactionId: 'x' }));
      const rollback = wager(Kind.Rollback, '10.00', { referenceExternalTransactionId: 'x' });

      expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
      expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
      expect(() => wager(Kind.Loss, '1.00').ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
    });
  });
});
