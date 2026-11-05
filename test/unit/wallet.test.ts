import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError, InvalidAmountError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money/money';
import { LedgerDirection } from '../../src/domain/wagering/kinds';
import { Wallet } from '../../src/domain/wallet/wallet';
import { brl, NOW, openWallet } from './fixtures';

const movement = (amount: string) => ({ money: brl(amount), transactionId: 'tx-1', ledgerEntryId: 'entry-1', at: NOW });

describe('Wallet', () => {
  test('opens with the initial balance, version 1 and an opening credit entry from zero', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: brl('1000.00'),
      openingTransactionId: 'opening-tx',
      openingLedgerEntryId: 'e',
      at: NOW,
    });
    expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toJSON().amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.toJSON().amount).toBe('1000.00');
    expect(openingEntry?.transactionId).toBe('opening-tx');
  });

  test('opens with zero balance without a ledger entry', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: Money.zero('BRL'),
      openingTransactionId: 'o',
      openingLedgerEntryId: 'e',
      at: NOW,
    });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('debit reduces the balance, increments version and returns a balanced entry', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(movement('80.00'));
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('credit increases the balance and increments version', () => {
    const wallet = openWallet('10.00');
    wallet.credit(movement('5.50'));
    expect(wallet.balance.toJSON().amount).toBe('15.50');
    expect(wallet.version).toBe(2);
  });

  test('debit above the balance throws and leaves the wallet untouched', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(movement('100.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('debit of the exact balance leaves zero, never negative', () => {
    const wallet = openWallet('80.00');
    wallet.debit(movement('80.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('rejects a movement in another currency', () => {
    const wallet = openWallet('100.00');
    const usd = { ...movement('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('rejects zero movements so version only changes when the balance changes', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.credit(movement('0.00'))).toThrow(InvalidAmountError);
    expect(wallet.version).toBe(1);
  });

  test('rehydrate restores state without validation', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toJSON().amount).toBe('42.00');
  });
});
