import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, UnbalancedLedgerEntryError } from '../../src/domain/errors';
import { WalletLedgerEntry } from '../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../src/domain/money/money';
import { LedgerDirection } from '../../src/domain/wagering/kinds';
import { brl, NOW } from './fixtures';

const base = {
  id: 'e',
  walletId: 'w',
  transactionId: 't',
  createdAt: NOW,
};

describe('WalletLedgerEntry', () => {
  test('accepts a balanced credit and debit', () => {
    const credit = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('125.00'),
    });
    const debit = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
    });
    expect(credit.isBalanced()).toBe(true);
    expect(debit.isBalanced()).toBe(true);
  });

  test('rejects an unbalanced entry', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('80.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('rejects a zero amount and a negative resulting balance', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('1.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('5.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('1.00').subtract(brl('5.00')),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('rejects mixed currencies', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: '1.00', currency: 'USD' }),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('2.00'),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  test('has no mutable surface', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('1.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('1.00'),
    });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry)).filter((name) => name !== 'constructor');
    expect(methods).toEqual(['isBalanced']);
  });
});
