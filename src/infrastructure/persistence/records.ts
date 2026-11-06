import { EntitySchema } from '@mikro-orm/core';

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'text' },
    currency: { type: 'character', length: 3 },
    balanceAmount: { type: 'decimal', precision: 20, scale: 2 },
    version: { type: 'integer' },
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  status!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  failureCode!: string | null;
  resultingBalanceAmount!: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt!: Date | null;
  createdAt!: Date;
  processedAt!: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'text' },
    externalTransactionId: { type: 'text' },
    idempotencyKey: { type: 'text' },
    payloadHash: { type: 'text' },
    walletId: { type: 'uuid' },
    playerId: { type: 'text' },
    roundId: { type: 'text' },
    gameId: { type: 'text' },
    kind: { type: 'text' },
    status: { type: 'text' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    currency: { type: 'character', length: 3 },
    referenceExternalTransactionId: { type: 'text', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    failureCode: { type: 'text', nullable: true },
    resultingBalanceAmount: { type: 'decimal', precision: 20, scale: 2, nullable: true },
    referenceAttempts: { type: 'integer' },
    nextReferenceAttemptAt: { type: 'datetime', nullable: true },
    createdAt: { type: 'datetime' },
    processedAt: { type: 'datetime', nullable: true },
  },
});

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  currency!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    currency: { type: 'character', length: 3 },
    transactionId: { type: 'uuid' },
    direction: { type: 'text' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    balanceBefore: { type: 'decimal', precision: 20, scale: 2 },
    balanceAfter: { type: 'decimal', precision: 20, scale: 2 },
    createdAt: { type: 'datetime' },
  },
});

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'text', primary: true },
    messageId: { type: 'text', primary: true },
    payloadHash: { type: 'text' },
    receivedAt: { type: 'datetime' },
    processedAt: { type: 'datetime', nullable: true },
  },
});

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'text' },
    eventType: { type: 'text' },
    payload: { type: 'json' },
    occurredAt: { type: 'datetime' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', nullable: true },
    publishedAt: { type: 'datetime', nullable: true },
  },
});

export const persistenceSchemas = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
