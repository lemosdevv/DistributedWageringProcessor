import type { MoneyProps } from '../money/money';
import type { FailureCode } from '../wagering/failure-code';
import type { WagerTransactionKind } from '../wagering/kinds';
import type { WagerTransaction } from '../wagering/wager-transaction';
import { IntegrationEvent, type EventContext } from './integration-event';

interface TransactionIdentityData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function identityOf(transaction: WagerTransaction): TransactionIdentityData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}

function requireDefined<T>(value: T | undefined, field: string, transaction: WagerTransaction): T {
  if (value === undefined) {
    throw new Error(`Transaction ${transaction.id} has no ${field} for its event`);
  }
  return value;
}

export interface WagerTransactionProcessedData extends TransactionIdentityData {
  referenceTransactionId: string | null;
  balance: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...identityOf(transaction),
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        balance: requireDefined(transaction.resultingBalance, 'resultingBalance', transaction).toJSON(),
        processedAt: requireDefined(transaction.processedAt, 'processedAt', transaction).toISOString(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends TransactionIdentityData {
  failureCode: FailureCode;
  referenceExternalTransactionId: string | null;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...identityOf(transaction),
        failureCode: requireDefined(transaction.failureCode, 'failureCode', transaction),
        referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionIdentityData {
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...identityOf(transaction),
        referenceExternalTransactionId: requireDefined(
          transaction.referenceExternalTransactionId,
          'referenceExternalTransactionId',
          transaction,
        ),
      },
    });
  }
}
