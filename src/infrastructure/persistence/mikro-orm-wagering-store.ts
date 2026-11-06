import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import {
  ConcurrencyConflictError,
  DuplicateWriteError,
  type TransactionRunner,
  type WageringStore,
} from '../../application/ports/wagering-store';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { WagerTransactionStatus, type WagerTransactionKind } from '../../domain/wagering/kinds';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import {
  inboxToDomain,
  inboxToRecord,
  ledgerEntryToRecord,
  outboxToRecord,
  transactionStateToRecord,
  transactionToDomain,
  transactionToRecord,
  walletToDomain,
  walletToRecord,
} from './mappers';
import {
  InboxMessageSchema,
  LedgerEntrySchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletSchema,
} from './records';

export class MikroOrmWageringStore implements WageringStore {
  constructor(private readonly em: EntityManager) {}

  async findWalletForUpdate(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? walletToDomain(record) : undefined;
  }

  async findWallet(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id: walletId });
    return record ? walletToDomain(record) : undefined;
  }

  async addWallet(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, walletToRecord(wallet));
  }

  async updateWalletBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const record = walletToRecord(wallet);
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balanceAmount: record.balanceAmount, version: record.version, updatedAt: record.updatedAt },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(wallet.id);
    }
  }

  async findTransactionById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, { id });
    return record ? transactionToDomain(record) : undefined;
  }

  async findTransactionByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, { idempotencyKey });
    return record ? transactionToDomain(record) : undefined;
  }

  async findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, { providerId, externalTransactionId });
    return record ? transactionToDomain(record) : undefined;
  }

  async hasProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async addTransaction(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, transactionToRecord(transaction));
  }

  async updateTransaction(transaction: WagerTransaction): Promise<void> {
    await this.em.nativeUpdate(WagerTransactionSchema, { id: transaction.id }, transactionStateToRecord(transaction));
  }

  async addLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, ledgerEntryToRecord(entry));
  }

  async findInboxMessage(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageSchema, { consumerName, messageId });
    return record ? inboxToDomain(record) : undefined;
  }

  async addInboxMessage(message: InboxMessage): Promise<void> {
    await this.em.insert(InboxMessageSchema, inboxToRecord(message));
  }

  async addOutboxMessages(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length > 0) {
      await this.em.insertMany(OutboxMessageSchema, messages.map(outboxToRecord));
    }
  }
}

export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(work: (store: WageringStore) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional((em) => work(new MikroOrmWageringStore(em)));
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new DuplicateWriteError(constraintOf(error), error);
      }
      throw error;
    }
  }
}

function constraintOf(error: UniqueConstraintViolationException): string | undefined {
  const constraint = (error as unknown as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}
