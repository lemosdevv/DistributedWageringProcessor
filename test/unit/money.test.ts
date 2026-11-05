import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  describe('from', () => {
    test('keeps the decimal string with fixed scale of 2', () => {
      expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    });

    test.each([
      ['25', '25.00'],
      ['25.5', '25.50'],
      ['0', '0.00'],
      ['0.01', '0.01'],
      ['1000000000000.99', '1000000000000.99'],
    ])('normalizes %p to %p', (input, expected) => {
      expect(brl(input).toString()).toBe(`${expected} BRL`);
      expect(brl(input).toJSON().amount).toBe(expected);
    });

    test.each([
      'NaN',
      'Infinity',
      '-Infinity',
      '1e2',
      '1E-2',
      '',
      ' ',
      ' 10.00',
      '10.001',
      '-5.00',
      '+5.00',
      'abc',
      '10,00',
      '0x10',
      '.50',
      '5.',
    ])('rejects invalid amount %p', (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    test('rejects a non-string amount at runtime', () => {
      expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    test.each(['brl', 'BR', 'BRLL', '', '123'])('rejects invalid currency %p', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });
  });

  describe('zero', () => {
    test('creates a zero amount in the given currency', () => {
      const zero = Money.zero('BRL');
      expect(zero.isZero()).toBe(true);
      expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    });
  });

  describe('arithmetic', () => {
    test('adds exactly without floating point drift', () => {
      expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
    });

    test('subtracts and may produce a negative result internally', () => {
      const result = brl('20.00').subtract(brl('80.00'));
      expect(result.toJSON().amount).toBe('-60.00');
      expect(result.isNegative()).toBe(true);
    });

    test('negates', () => {
      expect(brl('25.00').negate().toJSON().amount).toBe('-25.00');
      expect(brl('0.00').negate().toJSON().amount).toBe('0.00');
    });

    test('is immutable', () => {
      const a = brl('10.00');
      a.add(brl('5.00'));
      a.subtract(brl('5.00'));
      a.negate();
      expect(a.toJSON().amount).toBe('10.00');
    });

    test.each([
      ['add', (a: Money, b: Money) => a.add(b)],
      ['subtract', (a: Money, b: Money) => a.subtract(b)],
      ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
    ] as const)('%s between different currencies throws a domain error', (_name, operation) => {
      const usd = Money.from({ amount: '1.00', currency: 'USD' });
      expect(() => operation(brl('1.00'), usd)).toThrow(CurrencyMismatchError);
    });
  });

  describe('comparisons', () => {
    test('sign checks', () => {
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.00').isPositive()).toBe(false);
      expect(brl('0.00').isNegative()).toBe(false);
      expect(brl('0.00').isZero()).toBe(true);
    });

    test('isLessThan', () => {
      expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
      expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    });

    test('equals compares value and currency', () => {
      expect(brl('10').equals(brl('10.00'))).toBe(true);
      expect(brl('10.00').equals(brl('10.01'))).toBe(false);
      expect(brl('10.00').equals(Money.from({ amount: '10.00', currency: 'USD' }))).toBe(false);
    });
  });

  describe('serialization', () => {
    test('JSON.stringify produces the contract format', () => {
      expect(JSON.stringify(brl('25.00'))).toBe('{"amount":"25.00","currency":"BRL"}');
    });
  });
});
