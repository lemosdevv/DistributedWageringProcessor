import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, resetDatabase } from '../helpers/database';
import { call, startHttpApp, type RunningApp } from '../helpers/http-app';

let orm: MikroORM;
let running: RunningApp;
let walletId: string;
let sequence = 0;

const api = (method: string, path: string, options?: Parameters<typeof call>[3]) => call(running.baseUrl, method, path, options);

function transactionBody(overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `transaction-${++sequence}`,
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

function submit(body: Record<string, unknown>, key = `${body.providerId}:${body.externalTransactionId}`) {
  return api('POST', '/wagering/transactions', { body, headers: { 'Idempotency-Key': key } });
}

beforeAll(async () => {
  orm = await createTestOrm();
  running = await startHttpApp();
});

afterAll(async () => {
  await running.close();
  await orm.close(true);
});

beforeEach(async () => {
  await resetDatabase(orm);
  const created = await api('POST', '/wallets', {
    body: { playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1', initialBalance: { amount: '1000.00', currency: 'BRL' } },
  });
  walletId = created.body.id;
});

describe('wallets', () => {
  test('POST /wallets → 201 with the contract shape', async () => {
    const response = await api('POST', '/wallets', {
      body: { playerId: 'player-x', initialBalance: { amount: '1000.00', currency: 'BRL' } },
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      playerId: 'player-x',
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
  });

  test('duplicate wallet → 409 WALLET_ALREADY_EXISTS', async () => {
    const response = await api('POST', '/wallets', {
      body: { playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1', initialBalance: { amount: '1.00', currency: 'BRL' } },
    });
    expect(response.status).toBe(409);
    expect(response.body.failureCode).toBe('WALLET_ALREADY_EXISTS');
  });

  test('numeric amount → 400 INVALID_PAYLOAD', async () => {
    const response = await api('POST', '/wallets', { body: { playerId: 'p', initialBalance: { amount: 10, currency: 'BRL' } } });
    expect(response.status).toBe(400);
    expect(response.body.failureCode).toBe('INVALID_PAYLOAD');
  });

  test('GET /wallets/:id, ledger and reconciliation', async () => {
    await submit(transactionBody());
    expect((await api('GET', `/wallets/${walletId}`)).body).toMatchObject({ balance: { amount: '975.00' }, version: 2 });

    const ledger = await api('GET', `/wallets/${walletId}/ledger?limit=1`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.items).toHaveLength(1);
    const next = await api('GET', `/wallets/${walletId}/ledger?limit=1&cursor=${ledger.body.nextCursor}`);
    expect(next.body.items[0].direction).toBe('DEBIT');

    const reconciliation = await api('POST', `/wallets/${walletId}/reconciliation`);
    expect(reconciliation.status).toBe(200);
    expect(reconciliation.body).toMatchObject({ consistent: true, checkedEntries: 2, difference: { amount: '0.00' } });
  });

  test('unknown wallet → 404 WALLET_NOT_FOUND; malformed id → 400', async () => {
    const missing = await api('GET', `/wallets/${Bun.randomUUIDv7()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.failureCode).toBe('WALLET_NOT_FOUND');
    expect((await api('GET', '/wallets/not-a-uuid')).status).toBe(400);
  });
});

describe('POST /wagering/transactions', () => {
  test('PROCESSED → 200 with the contract shape', async () => {
    const response = await submit(transactionBody());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(response.headers.get('x-correlation-id')).toBeTruthy();
  });

  test('identical retry → same response with idempotentReplay: true', async () => {
    const body = transactionBody();
    const first = await submit(body);
    const replay = await submit(body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('same key, different payload → 409 IDEMPOTENCY_CONFLICT', async () => {
    const body = transactionBody();
    await submit(body);
    const conflict = await submit({ ...body, money: { amount: '30.00', currency: 'BRL' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.failureCode).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('business rejection → 422 with failureCode, and the replay keeps 422', async () => {
    const body = transactionBody({ money: { amount: '5000.00', currency: 'BRL' } });
    const rejected = await submit(body);
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: false });
    const replay = await submit(body);
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test('missing reference → 202 PENDING_REFERENCE', async () => {
    const response = await submit(transactionBody({ kind: 'ROLLBACK', referenceExternalTransactionId: 'not-yet' }));
    expect(response.status).toBe(202);
    expect(response.body.status).toBe('PENDING_REFERENCE');
  });

  test.each([
    ['missing Idempotency-Key', { omitKey: true }],
    ['numeric amount', { body: { money: { amount: 25, currency: 'BRL' } } }],
    ['scientific notation', { body: { money: { amount: '1e2', currency: 'BRL' } } }],
    ['three decimals', { body: { money: { amount: '1.001', currency: 'BRL' } } }],
    ['missing roundId', { body: { roundId: undefined } }],
    ['REFUND without reference', { body: { kind: 'REFUND' } }],
  ] as const)('%s → 400 INVALID_PAYLOAD', async (_name, scenario) => {
    const body = transactionBody('body' in scenario ? scenario.body : {});
    const response =
      'omitKey' in scenario
        ? await api('POST', '/wagering/transactions', { body })
        : await submit(body);
    expect(response.status).toBe(400);
    expect(response.body.failureCode).toBe('INVALID_PAYLOAD');
  });

  test('OPENING → 400 INTERNAL_KIND_NOT_ALLOWED', async () => {
    const response = await submit(transactionBody({ kind: 'OPENING' }));
    expect(response.status).toBe(400);
    expect(response.body.failureCode).toBe('INTERNAL_KIND_NOT_ALLOWED');
  });

  test('malformed JSON → 400 INVALID_PAYLOAD', async () => {
    const response = await api('POST', '/wagering/transactions', { body: '{"oops"', headers: { 'Idempotency-Key': 'k' } });
    expect(response.status).toBe(400);
    expect(response.body.failureCode).toBe('INVALID_PAYLOAD');
  });

  test('transaction is readable by id and by provider external id', async () => {
    const body = transactionBody();
    const submitted = await submit(body);
    const byId = await api('GET', `/wagering/transactions/${submitted.body.transactionId}`);
    const byExternal = await api('GET', `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(byId.status).toBe(200);
    expect(byExternal.body).toEqual(byId.body);
    expect((await api('GET', '/providers/provider-a/wagering/transactions/unknown')).body.failureCode).toBe(
      'TRANSACTION_NOT_FOUND',
    );
  });
});

describe('health', () => {
  test('GET /health/live is open', async () => {
    const response = await api('GET', '/health/live');
    expect(response.status).toBe(200);
  });
});
