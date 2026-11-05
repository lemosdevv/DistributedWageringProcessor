import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';

/** Posição de keyset no ledger: ordem estável por (createdAt, id). */
export interface LedgerPosition {
  createdAt: Date;
  id: string;
}

export interface LedgerSnapshot {
  wallet: Wallet;
  /** Soma dos créditos e dos débitos, separadas para nunca materializar um Money negativo. */
  totalCredits: Money;
  totalDebits: Money;
  entries: number;
}

/** Leituras sem efeito colateral (API de consulta e reconciliação). */
export interface WageringQueries {
  findWallet(walletId: string): Promise<Wallet | undefined>;
  findTransactionById(id: string): Promise<WagerTransaction | undefined>;
  findTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  listLedger(walletId: string, after: LedgerPosition | undefined, limit: number): Promise<WalletLedgerEntry[]>;
  /**
   * Saldo armazenado e somas do ledger lidos sob o mesmo lock compartilhado da wallet,
   * para que nenhuma escrita concorrente caia entre as duas leituras.
   */
  ledgerSnapshot(walletId: string): Promise<LedgerSnapshot | undefined>;
}

export const WAGERING_QUERIES = Symbol('WAGERING_QUERIES');
