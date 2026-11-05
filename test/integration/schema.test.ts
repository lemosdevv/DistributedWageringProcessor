import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, resetDatabase, sql } from '../helpers/database';

let orm: MikroORM;

const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';
const BET = '0192f298-345e-7e38-af88-e43f851a819d';
const REFUND_A = '0192f298-345e-7e38-af88-e43f851a8100';
const REFUND_B = '0192f298-345e-7e38-af88-e43f851a8101';

async function expectRejected(query: string, params: unknown[], constraintOrMessage: string): Promise<void> {
  let error: unknown;
  try {
    await sql(orm, query, params);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  expect(String((error as Error).message)).toContain(constraintOrMessage);
}

async function insertWallet(id = WALLET, playerId = 'player-1', balance = '100.00'): Promise<void> {
  await sql(
    orm,
    `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
     values (?, ?, 'BRL', ?, 1, now(), now())`,
    [id, playerId, balance],
  );
}

async function insertTransaction(
  id: string,
  overrides: Partial<{ kind: string; status: string; amount: string; ref: string | null; refId: string | null; ext: string }> = {},
): Promise<void> {
  const ext = overrides.ext ?? `ext-${id}`;
  await sql(
    orm,
    `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
       player_id, round_id, game_id, kind, status, amount, currency, reference_external_transaction_id,
       reference_transaction_id, processed_at, created_at)
     values (?, 'provider-a', ?, ?, 'hash', ?, 'player-1', 'round-1', 'game', ?, ?, ?, 'BRL', ?, ?, now(), now())`,
    [
      id,
      ext,
      `provider-a:${ext}`,
      WALLET,
      overrides.kind ?? 'BET',
      overrides.status ?? 'PROCESSED',
      overrides.amount ?? '10.00',
      overrides.ref ?? null,
      overrides.refId ?? null,
    ],
  );
}

async function insertLedger(
  id: string,
  transactionId: string,
  values: { direction?: string; amount?: string; before?: string; after?: string; currency?: string } = {},
): Promise<void> {
  await sql(
    orm,
    `insert into wallet_ledger_entries (id, wallet_id, currency, transaction_id, direction, amount, balance_before, balance_after, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [
      id,
      WALLET,
      values.currency ?? 'BRL',
      transactionId,
      values.direction ?? 'DEBIT',
      values.amount ?? '10.00',
      values.before ?? '100.00',
      values.after ?? '90.00',
    ],
  );
}

beforeAll(async () => {
  orm = await createTestOrm();
});

afterAll(async () => {
  await orm.close(true);
});

beforeEach(async () => {
  await resetDatabase(orm);
});

describe('migrations', () => {
  test('are reversible: up → down → up', async () => {
    await orm.migrator.down({ to: 0 });
    const afterDown = await sql<{ table_name: string }>(
      orm,
      `select table_name from information_schema.tables where table_schema = 'public' and table_name <> 'mikro_orm_migrations'`,
    );
    expect(afterDown).toEqual([]);

    await orm.migrator.up();
    const tables = await sql<{ table_name: string }>(
      orm,
      `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      'inbox_messages',
      'mikro_orm_migrations',
      'outbox_messages',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);
  });
});

describe('wallets constraints', () => {
  test('balance can never be negative', async () => {
    await expectRejected(
      `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       values (?, 'p', 'BRL', -0.01, 1, now(), now())`,
      [WALLET],
      'wallets_balance_amount_check',
    );
  });

  test('a player has at most one wallet per currency', async () => {
    await insertWallet();
    await expectRejected(
      `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       values (gen_random_uuid(), 'player-1', 'BRL', 0, 1, now(), now())`,
      [],
      'wallets_player_currency_unique',
    );
  });

  test('money columns keep exact decimals', async () => {
    await insertWallet(WALLET, 'player-1', '0.30');
    const [row] = await sql<{ balance_amount: string }>(orm, 'select balance_amount from wallets');
    expect(String(row?.balance_amount)).toBe('0.30');
  });
});

describe('wager_transactions constraints', () => {
  beforeEach(async () => {
    await insertWallet();
  });

  test('idempotency key is unique', async () => {
    await insertTransaction(BET, { ext: 'tx-1' });
    await expectRejected(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
         player_id, round_id, game_id, kind, status, amount, currency, created_at)
       values (gen_random_uuid(), 'provider-b', 'other', 'provider-a:tx-1', 'h', ?, 'player-1', 'r', 'g', 'BET', 'PENDING', 1, 'BRL', now())`,
      [WALLET],
      'wager_transactions_idempotency_key_unique',
    );
  });

  test('(provider, external id) is unique', async () => {
    await insertTransaction(BET, { ext: 'tx-1' });
    await expectRejected(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
         player_id, round_id, game_id, kind, status, amount, currency, created_at)
       values (gen_random_uuid(), 'provider-a', 'tx-1', 'another-key', 'h', ?, 'player-1', 'r', 'g', 'BET', 'PENDING', 1, 'BRL', now())`,
      [WALLET],
      'wager_transactions_provider_external_unique',
    );
  });

  test('REFUND and ROLLBACK require a reference', async () => {
    await expectRejected(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
         player_id, round_id, game_id, kind, status, amount, currency, created_at)
       values (gen_random_uuid(), 'p', 'x', 'p:x', 'h', ?, 'player-1', 'r', 'g', 'REFUND', 'PENDING', 1, 'BRL', now())`,
      [WALLET],
      'wager_transactions_reference_required',
    );
  });

  test('only LOSS may have a zero amount', async () => {
    await insertTransaction(BET, { kind: 'LOSS', amount: '0.00' });
    await expectRejected(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
         player_id, round_id, game_id, kind, status, amount, currency, created_at)
       values (gen_random_uuid(), 'p', 'y', 'p:y', 'h', ?, 'player-1', 'r', 'g', 'BET', 'PENDING', 0, 'BRL', now())`,
      [WALLET],
      'wager_transactions_positive_amount',
    );
  });

  test('a rejected transaction must carry a failure code', async () => {
    await expectRejected(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
         player_id, round_id, game_id, kind, status, amount, currency, processed_at, created_at)
       values (gen_random_uuid(), 'p', 'z', 'p:z', 'h', ?, 'player-1', 'r', 'g', 'BET', 'REJECTED', 1, 'BRL', now(), now())`,
      [WALLET],
      'wager_transactions_failure_code_required',
    );
  });

  test('a reference can be reverted only once per kind, even if the application lets two through', async () => {
    await insertTransaction(BET);
    await insertTransaction(REFUND_A, { kind: 'REFUND', ref: `ext-${BET}`, refId: BET });
    await expectRejected(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
         player_id, round_id, game_id, kind, status, amount, currency, reference_external_transaction_id,
         reference_transaction_id, processed_at, created_at)
       values (?, 'provider-a', 'refund-b', 'provider-a:refund-b', 'h', ?, 'player-1', 'round-1', 'g', 'REFUND', 'PROCESSED',
         10, 'BRL', ?, ?, now(), now())`,
      [REFUND_B, WALLET, `ext-${BET}`, BET],
      'wager_transactions_single_reversal',
    );
  });

  test('a ROLLBACK of an already refunded BET is still allowed (different kind)', async () => {
    await insertTransaction(BET);
    await insertTransaction(REFUND_A, { kind: 'REFUND', ref: `ext-${BET}`, refId: BET });
    await insertTransaction(REFUND_B, { kind: 'ROLLBACK', ref: `ext-${BET}`, refId: BET });
    const [row] = await sql<{ count: string }>(orm, 'select count(*) from wager_transactions');
    expect(Number(row?.count)).toBe(3);
  });
});

describe('wallet_ledger_entries constraints', () => {
  beforeEach(async () => {
    await insertWallet();
    await insertTransaction(BET);
  });

  test('accepts a balanced entry', async () => {
    await insertLedger('0192f2a0-0000-7000-8000-000000000001', BET);
    const rows = await sql(orm, 'select * from wallet_ledger_entries');
    expect(rows).toHaveLength(1);
  });

  test('rejects an unbalanced entry', async () => {
    await expectRejected(
      `insert into wallet_ledger_entries (id, wallet_id, currency, transaction_id, direction, amount, balance_before, balance_after, created_at)
       values (gen_random_uuid(), ?, 'BRL', ?, 'DEBIT', 10, 100, 95, now())`,
      [WALLET, BET],
      'wallet_ledger_entries_balanced',
    );
  });

  test('rejects an entry that leaves a negative balance', async () => {
    await expectRejected(
      `insert into wallet_ledger_entries (id, wallet_id, currency, transaction_id, direction, amount, balance_before, balance_after, created_at)
       values (gen_random_uuid(), ?, 'BRL', ?, 'DEBIT', 10, 5, -5, now())`,
      [WALLET, BET],
      'wallet_ledger_entries_balance_after_check',
    );
  });

  test('rejects an entry in a currency other than the wallet currency', async () => {
    await expectRejected(
      `insert into wallet_ledger_entries (id, wallet_id, currency, transaction_id, direction, amount, balance_before, balance_after, created_at)
       values (gen_random_uuid(), ?, 'USD', ?, 'DEBIT', 10, 100, 90, now())`,
      [WALLET, BET],
      'wallet_ledger_entries_wallet_currency_fk',
    );
  });

  test('allows at most one entry per transaction', async () => {
    await insertLedger('0192f2a0-0000-7000-8000-000000000001', BET);
    await expectRejected(
      `insert into wallet_ledger_entries (id, wallet_id, currency, transaction_id, direction, amount, balance_before, balance_after, created_at)
       values (gen_random_uuid(), ?, 'BRL', ?, 'DEBIT', 10, 90, 80, now())`,
      [WALLET, BET],
      'wallet_ledger_entries_transaction_unique',
    );
  });

  test('is append-only: UPDATE, DELETE and TRUNCATE are rejected', async () => {
    await insertLedger('0192f2a0-0000-7000-8000-000000000001', BET);
    await expectRejected(`update wallet_ledger_entries set amount = 1`, [], 'append-only');
    await expectRejected(`delete from wallet_ledger_entries`, [], 'append-only');
    await expectRejected(`truncate wallet_ledger_entries`, [], 'append-only');
    const rows = await sql(orm, 'select * from wallet_ledger_entries');
    expect(rows).toHaveLength(1);
  });
});

describe('inbox_messages constraints', () => {
  test('(consumer, message id) is unique', async () => {
    await sql(orm, `insert into inbox_messages values ('consumer', 'msg-1', 'h', now(), null)`);
    await expectRejected(`insert into inbox_messages values ('consumer', 'msg-1', 'h', now(), null)`, [], 'inbox_messages_pk');
    await sql(orm, `insert into inbox_messages values ('other-consumer', 'msg-1', 'h', now(), null)`);
  });
});
