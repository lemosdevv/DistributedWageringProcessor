import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { WagerTransactionKind } from '../../domain/wagering/kinds';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';

/**
 * Acesso a dados de uma única transação SQL. Tudo o que é escrito por meio de um
 * store é confirmado junto (commit) ou descartado junto (rollback).
 */
export interface WageringStore {
  /** SELECT … FOR UPDATE somente na linha da wallet (ADR-0002). */
  findWalletForUpdate(walletId: string): Promise<Wallet | undefined>;
  findWallet(walletId: string): Promise<Wallet | undefined>;
  addWallet(wallet: Wallet): Promise<void>;
  /**
   * Persiste saldo e version, condicionado à version lida (defesa extra além do lock).
   * Lança ConcurrencyConflictError se outra escrita passou na frente.
   */
  updateWalletBalance(wallet: Wallet, expectedVersion: number): Promise<void>;

  findTransactionById(id: string): Promise<WagerTransaction | undefined>;
  findTransactionByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  hasProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean>;
  addTransaction(transaction: WagerTransaction): Promise<void>;
  updateTransaction(transaction: WagerTransaction): Promise<void>;

  addLedgerEntry(entry: WalletLedgerEntry): Promise<void>;

  findInboxMessage(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  addInboxMessage(message: InboxMessage): Promise<void>;

  addOutboxMessages(messages: readonly OutboxMessage[]): Promise<void>;
}

export interface TransactionRunner {
  /** Executa o trabalho numa transação SQL nova; commit no sucesso, rollback em erro. */
  run<T>(work: (store: WageringStore) => Promise<T>): Promise<T>;
}

export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');

/**
 * Uma constraint de unicidade do banco barrou a escrita (idempotency key, inbox,
 * reversão única…). Outra instância venceu a corrida: repetir a operação vira replay.
 */
export class DuplicateWriteError extends Error {
  constructor(public readonly constraint: string | undefined, cause: unknown) {
    super(`Duplicate write rejected by constraint ${constraint ?? 'unknown'}`, { cause });
    this.name = 'DuplicateWriteError';
  }
}

/** Escrita condicionada pela version perdeu a corrida: a operação pode ser repetida. */
export class ConcurrencyConflictError extends Error {
  constructor(walletId: string) {
    super(`Concurrent update detected on wallet ${walletId}`);
    this.name = 'ConcurrencyConflictError';
  }
}
