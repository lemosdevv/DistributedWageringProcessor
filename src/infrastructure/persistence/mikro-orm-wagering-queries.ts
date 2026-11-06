import { LockMode } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { LedgerPosition, LedgerSnapshot, WageringQueries } from '../../application/ports/wagering-queries';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import { ledgerEntryToDomain, transactionToDomain, walletToDomain } from './mappers';
import { LedgerEntrySchema, WagerTransactionSchema, WalletSchema } from './records';

export class MikroOrmWageringQueries implements WageringQueries {
  constructor(private readonly orm: MikroORM) {}

  async findWallet(walletId: string): Promise<Wallet | undefined> {
    const record = await this.orm.em.fork().findOne(WalletSchema, { id: walletId });
    return record ? walletToDomain(record) : undefined;
  }

  async findTransactionById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.orm.em.fork().findOne(WagerTransactionSchema, { id });
    return record ? transactionToDomain(record) : undefined;
  }

  async findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.orm.em.fork().findOne(WagerTransactionSchema, { providerId, externalTransactionId });
    return record ? transactionToDomain(record) : undefined;
  }

  async listLedger(walletId: string, after: LedgerPosition | undefined, limit: number): Promise<WalletLedgerEntry[]> {
    const keyset = after
      ? { $or: [{ createdAt: { $gt: after.createdAt } }, { createdAt: after.createdAt, id: { $gt: after.id } }] }
      : {};
    const records = await this.orm.em.fork().find(
      LedgerEntrySchema,
      { walletId, ...keyset },
      { orderBy: { createdAt: 'asc', id: 'asc' }, limit },
    );
    return records.map(ledgerEntryToDomain);
  }

  ledgerSnapshot(walletId: string): Promise<LedgerSnapshot | undefined> {
    return this.orm.em.fork().transactional(async (em) => {
      const record = await em.findOne(WalletSchema, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_READ });
      if (!record) {
        return undefined;
      }
      const [totals] = await em.execute<{ credits: string; debits: string; entries: string }[]>(
        `select coalesce(sum(amount) filter (where direction = 'CREDIT'), 0)::numeric(20, 2)::text as credits,
                coalesce(sum(amount) filter (where direction = 'DEBIT'), 0)::numeric(20, 2)::text as debits,
                count(*)::text as entries
           from wallet_ledger_entries
          where wallet_id = ?`,
        [walletId],
      );
      return {
        wallet: walletToDomain(record),
        totalCredits: Money.from({ amount: totals?.credits ?? '0', currency: record.currency }),
        totalDebits: Money.from({ amount: totals?.debits ?? '0', currency: record.currency }),
        entries: Number(totals?.entries ?? 0),
      };
    });
  }
}
