import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { InvalidPayloadError, WagerTransactionNotFoundError, WalletNotFoundError } from '../../src/application/errors';
import { noopMetrics, type WageringMetrics } from '../../src/application/ports/metrics';
import type { LogContext, StructuredLogger } from '../../src/application/ports/observability';
import { WageringQueryService } from '../../src/application/queries/wagering-query.service';
import { ReconcileWalletUseCase } from '../../src/application/wallets/reconcile-wallet.use-case';
import { MikroOrmWageringQueries } from '../../src/infrastructure/persistence/mikro-orm-wagering-queries';
import { createTestOrm, resetDatabase, sql } from '../helpers/database';
import { buildUseCases, keyOf, wagerCommand } from '../helpers/wagering';

let orm: MikroORM;
let useCases: ReturnType<typeof buildUseCases>;
let queries: WageringQueryService;
let walletId: string;

async function bet(amount: string) {
  const command = wagerCommand(walletId, { money: { amount, currency: 'BRL' } });
  const result = await useCases.processWager.execute(command, { idempotencyKey: keyOf(command), correlationId: 'c' });
  return { command, result };
}

beforeAll(async () => {
  orm = await createTestOrm();
  useCases = buildUseCases(orm);
  queries = new WageringQueryService(new MikroOrmWageringQueries(orm));
});

afterAll(async () => {
  await orm.close(true);
});

beforeEach(async () => {
  await resetDatabase(orm);
  walletId = (
    await useCases.createWallet.execute({ playerId: 'player-1', initialBalance: { amount: '100.00', currency: 'BRL' } }, 'c')
  ).id;
});

describe('queries', () => {
  test('GET wallet returns balance and version', async () => {
    await bet('10.00');
    expect(await queries.getWallet(walletId)).toEqual({
      id: walletId,
      playerId: 'player-1',
      balance: { amount: '90.00', currency: 'BRL' },
      version: 2,
    });
    await expect(queries.getWallet(Bun.randomUUIDv7())).rejects.toThrow(WalletNotFoundError);
  });

  test('transactions can be read by internal id and by provider external id', async () => {
    const { command, result } = await bet('10.00');
    const byId = await queries.getTransaction(result.transactionId);
    const byExternal = await queries.getTransactionByExternalId('provider-a', command.externalTransactionId);
    expect(byExternal).toEqual(byId);
    expect(byId).toMatchObject({ kind: 'BET', status: 'PROCESSED', balance: { amount: '90.00', currency: 'BRL' } });
    await expect(queries.getTransaction(Bun.randomUUIDv7())).rejects.toThrow(WagerTransactionNotFoundError);
  });

  test('ledger pagination with an opaque cursor visits every entry once, in order', async () => {
    for (let i = 1; i <= 6; i++) await bet(`${i}.00`);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await queries.getLedger(walletId, cursor, 3);
      seen.push(...page.items.map((item) => item.money.amount));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);

    expect(seen).toEqual(['100.00', '1.00', '2.00', '3.00', '4.00', '5.00', '6.00']);
    expect(pages).toBe(3);
  });

  test('a stable cursor keeps working after new entries are appended', async () => {
    await bet('1.00');
    const first = await queries.getLedger(walletId, undefined, 1);
    await bet('2.00');
    const second = await queries.getLedger(walletId, first.nextCursor!, 50);
    expect(second.items.map((item) => item.money.amount)).toEqual(['1.00', '2.00']);
    expect(second.nextCursor).toBeNull();
  });

  test.each(['not-a-cursor', Buffer.from('{"t":"x"}').toString('base64url')])('rejects invalid cursor %p', async (cursor) => {
    await expect(queries.getLedger(walletId, cursor, 10)).rejects.toThrow(InvalidPayloadError);
  });

  test.each([0, 201, 2.5])('rejects invalid limit %p', async (limit) => {
    await expect(queries.getLedger(walletId, undefined, limit)).rejects.toThrow(InvalidPayloadError);
  });
});

describe('reconciliation', () => {
  function recordingObservers() {
    const divergences: number[] = [];
    const errors: LogContext[] = [];
    const metrics: WageringMetrics = { ...noopMetrics, reconciliationDivergence: () => divergences.push(1) };
    const logger: StructuredLogger = { info: () => {}, warn: () => {}, error: (context) => errors.push(context) };
    return { divergences, errors, metrics, logger };
  }

  test('a consistent wallet reports zero difference', async () => {
    await bet('25.00');
    const observers = recordingObservers();
    const report = await new ReconcileWalletUseCase(new MikroOrmWageringQueries(orm), observers.metrics, observers.logger).execute(
      walletId,
      'c',
    );
    expect(report).toEqual({
      walletId,
      storedBalance: { amount: '75.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
    expect(observers.divergences).toHaveLength(0);
  });

  test('a divergence is flagged, logged and counted, never silently corrected', async () => {
    await bet('25.00');
    await sql(orm, 'update wallets set balance_amount = 80.00 where id = ?', [walletId]);

    const observers = recordingObservers();
    const report = await new ReconcileWalletUseCase(new MikroOrmWageringQueries(orm), observers.metrics, observers.logger).execute(
      walletId,
      'corr-1',
    );

    expect(report).toMatchObject({
      consistent: false,
      storedBalance: { amount: '80.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '5.00', currency: 'BRL' },
    });
    expect(observers.divergences).toHaveLength(1);
    expect(observers.errors[0]).toMatchObject({ walletId, correlationId: 'corr-1' });
    const [row] = await sql<{ balance_amount: string }>(orm, 'select balance_amount::text from wallets where id = ?', [walletId]);
    expect(row?.balance_amount).toBe('80.00');
  });

  test('an unknown wallet is WALLET_NOT_FOUND', async () => {
    const useCase = new ReconcileWalletUseCase(new MikroOrmWageringQueries(orm), noopMetrics, recordingObservers().logger);
    await expect(useCase.execute(Bun.randomUUIDv7(), 'c')).rejects.toThrow(WalletNotFoundError);
  });
});
