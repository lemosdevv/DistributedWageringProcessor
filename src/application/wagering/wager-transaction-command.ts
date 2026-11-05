import type { MoneyProps } from '../../domain/money/money';

/** Contrato de negócio comum à entrada HTTP e à fila (§9, §10). */
export interface WagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/** Metadados de transporte: não entram no payloadHash. */
export interface WagerExecutionContext {
  idempotencyKey: string;
  correlationId: string;
  /** Presente quando a entrada é a fila: deduplicação persistente por (consumerName, messageId). */
  inbox?: { consumerName: string; messageId: string };
}
