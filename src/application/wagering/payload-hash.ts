import { createHash } from 'node:crypto';
import type { WagerTransactionCommand } from './wager-transaction-command';

type Canonical = string | number | boolean | null | Canonical[] | { [key: string]: Canonical };

/** JSON canônico: chaves ordenadas recursivamente, sem espaços. */
export function canonicalJson(value: Canonical): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as Canonical)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * payloadHash = SHA-256 (hex) do JSON canônico dos campos de negócio (§9).
 * Header Idempotency-Key, messageId e demais metadados de transporte ficam de fora.
 * `amount` já chega normalizado pelo Money (ex.: "25" e "25.00" geram o mesmo hash).
 */
export function computePayloadHash(command: WagerTransactionCommand): string {
  const businessFields: Canonical = {
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: { amount: command.money.amount, currency: command.money.currency },
    referenceExternalTransactionId: command.referenceExternalTransactionId ?? null,
  };
  return createHash('sha256').update(canonicalJson(businessFields)).digest('hex');
}
