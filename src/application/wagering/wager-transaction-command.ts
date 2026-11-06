import type { MoneyProps } from '../../domain/money/money';

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

export interface WagerExecutionContext {
  idempotencyKey: string;
  correlationId: string;
  inbox?: { consumerName: string; messageId: string };
}
