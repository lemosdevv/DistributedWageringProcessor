import { Money } from '../../src/domain/money/money';
import { WagerTransactionKind } from '../../src/domain/wagering/kinds';
import { WagerTransaction, type CreateWagerTransactionProps } from '../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';

export const NOW = new Date('2026-07-29T15:00:00.000Z');
export const PLAYER_ID = 'player-1';
export const WALLET_ID = 'wallet-1';

let sequence = 0;
export const nextId = (prefix = 'id') => `${prefix}-${++sequence}`;

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

export function openWallet(balance: string, overrides: Partial<{ id: string; playerId: string }> = {}): Wallet {
  return Wallet.open({
    id: overrides.id ?? WALLET_ID,
    playerId: overrides.playerId ?? PLAYER_ID,
    initialBalance: brl(balance),
    openingTransactionId: nextId('opening'),
    openingLedgerEntryId: nextId('entry'),
    at: NOW,
  }).wallet;
}

export function wager(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId('ext');
  return WagerTransaction.create({
    id: nextId('tx'),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: `hash-${externalTransactionId}`,
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    referenceExternalTransactionId: undefined,
    createdAt: NOW,
    ...overrides,
  });
}

export function processed(transaction: WagerTransaction, balance = brl('0.00')): WagerTransaction {
  transaction.markProcessed(undefined, NOW, balance);
  return transaction;
}
