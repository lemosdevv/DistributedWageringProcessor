import { InvalidPayloadError, WagerTransactionNotFoundError, WalletNotFoundError } from '../errors';
import type { LedgerPosition, WageringQueries } from '../ports/wagering-queries';
import { toWalletView, type WalletView } from '../wallets/create-wallet.use-case';
import { toLedgerEntryView, toTransactionView, type LedgerPage, type TransactionView } from './views';

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

export class WageringQueryService {
  constructor(private readonly queries: WageringQueries) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.queries.findWallet(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return toWalletView(wallet);
  }

  async getLedger(walletId: string, cursor: string | undefined, limit: number | undefined): Promise<LedgerPage> {
    const pageSize = limit ?? DEFAULT_LEDGER_LIMIT;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_LEDGER_LIMIT) {
      throw new InvalidPayloadError(`limit must be an integer between 1 and ${MAX_LEDGER_LIMIT}`);
    }
    if (!(await this.queries.findWallet(walletId))) {
      throw new WalletNotFoundError(walletId);
    }

    const entries = await this.queries.listLedger(walletId, cursor ? decodeCursor(cursor) : undefined, pageSize + 1);
    const page = entries.slice(0, pageSize);
    const last = page.at(-1);
    return {
      items: page.map(toLedgerEntryView),
      nextCursor: entries.length > pageSize && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  async getTransaction(transactionId: string): Promise<TransactionView> {
    const transaction = await this.queries.findTransactionById(transactionId);
    if (!transaction) {
      throw new WagerTransactionNotFoundError(transactionId);
    }
    return toTransactionView(transaction);
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const transaction = await this.queries.findTransactionByExternalId(providerId, externalTransactionId);
    if (!transaction) {
      throw new WagerTransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    }
    return toTransactionView(transaction);
  }
}

export function encodeCursor(position: LedgerPosition): string {
  return Buffer.from(JSON.stringify({ t: position.createdAt.toISOString(), i: position.id })).toString('base64url');
}

export function decodeCursor(cursor: string): LedgerPosition {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; i?: unknown };
    const createdAt = new Date(String(parsed.t));
    if (typeof parsed.t !== 'string' || typeof parsed.i !== 'string' || Number.isNaN(createdAt.getTime())) {
      throw new Error('malformed');
    }
    return { createdAt, id: parsed.i };
  } catch {
    throw new InvalidPayloadError('Invalid ledger cursor');
  }
}
