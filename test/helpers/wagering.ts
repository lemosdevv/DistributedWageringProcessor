import type { MikroORM } from '@mikro-orm/postgresql';
import { uuidV7Generator, type Clock } from '../../src/application/ports/system';
import { ProcessWagerTransactionUseCase } from '../../src/application/wagering/process-wager-transaction.use-case';
import type { WagerTransactionCommand } from '../../src/application/wagering/wager-transaction-command';
import { CreateWalletUseCase } from '../../src/application/wallets/create-wallet.use-case';
import { MikroOrmTransactionRunner } from '../../src/infrastructure/persistence/mikro-orm-wagering-store';
import { sql } from './database';

export function buildUseCases(orm: MikroORM, clock: Clock = { now: () => new Date() }) {
  const runner = new MikroOrmTransactionRunner(orm);
  return {
    runner,
    createWallet: new CreateWalletUseCase(runner, clock, uuidV7Generator),
    processWager: new ProcessWagerTransactionUseCase(runner, clock, uuidV7Generator),
  };
}

let sequence = 0;

/** Comando de exemplo no formato do README; cada chamada gera um externalTransactionId novo. */
export function wagerCommand(
  walletId: string,
  overrides: Partial<WagerTransactionCommand> = {},
): WagerTransactionCommand {
  return {
    providerId: 'provider-a',
    externalTransactionId: `transaction-${Date.now()}-${++sequence}`,
    playerId: 'player-1',
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

export const keyOf = (command: WagerTransactionCommand) => `${command.providerId}:${command.externalTransactionId}`;

export interface WalletConsistency {
  stored: string;
  rebuilt: string;
  version: number;
  entries: number;
}

/** Invariante final (§13): saldo materializado == saldo reconstruído pelo ledger. */
export async function walletConsistency(orm: MikroORM, walletId: string): Promise<WalletConsistency> {
  const [row] = await sql<{ stored: string; rebuilt: string; version: number; entries: string }>(
    orm,
    `select w.balance_amount::text as stored,
            coalesce(sum(case when e.direction = 'CREDIT' then e.amount else -e.amount end), 0)::numeric(20,2)::text as rebuilt,
            w.version,
            count(e.id) as entries
       from wallets w
       left join wallet_ledger_entries e on e.wallet_id = w.id
      where w.id = ?
      group by w.id`,
    [walletId],
  );
  if (!row) throw new Error(`wallet ${walletId} not found`);
  return { stored: row.stored, rebuilt: row.rebuilt, version: Number(row.version), entries: Number(row.entries) };
}
