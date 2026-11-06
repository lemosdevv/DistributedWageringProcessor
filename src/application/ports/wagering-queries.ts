import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';

export interface LedgerPosition {
  createdAt: Date;
  id: string;
}

export interface LedgerSnapshot {
  wallet: Wallet;
  totalCredits: Money;
  totalDebits: Money;
  entries: number;
}

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
