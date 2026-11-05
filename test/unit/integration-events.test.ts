import { describe, expect, test } from 'bun:test';
import type { EventContext } from '../../src/domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../src/domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../../src/domain/events/wallet-balance-changed';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { LedgerDirection, WagerTransactionKind as Kind } from '../../src/domain/wagering/kinds';
import { brl, NOW, openWallet, wager } from './fixtures';

const ctx: EventContext = { eventId: 'evt-1', correlationId: 'corr-1', causationId: 'msg-1', occurredAt: NOW };

describe('Integration events', () => {
  test('WalletBalanceChanged carries MoneyProps strings and the wallet version', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit({ money: brl('25.00'), transactionId: 'tx-1', ledgerEntryId: 'e-1', at: NOW });
    const event = WalletBalanceChanged.from(wallet, entry, ctx);

    expect(event.toJSON()).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: wallet.id,
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-07-29T15:00:00.000Z',
      version: 1,
      data: {
        walletId: wallet.id,
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  test('the envelope survives a JSON round-trip with exact decimal strings', () => {
    const tx = wager(Kind.Loss, '0.10');
    tx.markProcessed(undefined, NOW, brl('0.30'));
    const json = JSON.parse(JSON.stringify(WagerTransactionProcessed.from(tx, ctx)));
    expect(json.data.money).toEqual({ amount: '0.10', currency: 'BRL' });
    expect(json.data.balance).toEqual({ amount: '0.30', currency: 'BRL' });
    expect(json.eventType).toBe('WagerTransactionProcessed');
  });

  test('event type and version live on the type, not on the call site', () => {
    const tx = wager(Kind.Bet, '10.00');
    tx.reject(FailureCode.InsufficientFunds, NOW, brl('5.00'));
    const rejected = WagerTransactionRejected.from(tx, ctx);
    expect(rejected.eventType).toBe('WagerTransactionRejected');
    expect(rejected.version).toBe(1);
    expect(rejected.data.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('WagerTransactionPendingReference exposes the missing reference', () => {
    const tx = wager(Kind.Rollback, '10.00', { referenceExternalTransactionId: 'bet-42' });
    tx.markPendingReference();
    const event = WagerTransactionPendingReference.from(tx, ctx);
    expect(event.data.referenceExternalTransactionId).toBe('bet-42');
    expect(event.aggregateId).toBe(tx.id);
  });

  test('omits causationId when absent and freezes data', () => {
    const tx = wager(Kind.Loss, '1.00');
    tx.markProcessed(undefined, NOW, brl('1.00'));
    const event = WagerTransactionProcessed.from(tx, { eventId: 'e', correlationId: 'c', occurredAt: NOW });
    expect('causationId' in event.toJSON()).toBe(false);
    expect(Object.isFrozen(event.data)).toBe(true);
  });
});
