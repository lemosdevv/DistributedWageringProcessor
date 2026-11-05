import { describe, expect, test } from 'bun:test';
import { canonicalJson, computePayloadHash } from '../../src/application/wagering/payload-hash';
import type { WagerTransactionCommand } from '../../src/application/wagering/wager-transaction-command';

const command: WagerTransactionCommand = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('payload hash', () => {
  test('canonical JSON sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: null } })).toBe('{"a":{"c":null,"d":"x"},"b":1}');
  });

  test('is a stable sha-256 hex digest', () => {
    expect(computePayloadHash(command)).toMatch(/^[0-9a-f]{64}$/);
    expect(computePayloadHash(command)).toBe(computePayloadHash({ ...command }));
  });

  test('does not depend on key order', () => {
    const reordered = Object.fromEntries(Object.entries(command).reverse()) as unknown as WagerTransactionCommand;
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(command));
  });

  test.each([
    ['money.amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['money.currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['kind', { kind: 'WIN' }],
    ['walletId', { walletId: 'other' }],
    ['roundId', { roundId: 'other' }],
    ['referenceExternalTransactionId', { referenceExternalTransactionId: 'ref' }],
  ])('changes when %s changes', (_field, override) => {
    expect(computePayloadHash({ ...command, ...override })).not.toBe(computePayloadHash(command));
  });

  test('absent and undefined reference produce the same hash', () => {
    expect(computePayloadHash({ ...command, referenceExternalTransactionId: undefined })).toBe(computePayloadHash(command));
  });
});
