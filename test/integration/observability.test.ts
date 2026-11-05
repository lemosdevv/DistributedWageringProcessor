import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, resetDatabase } from '../helpers/database';
import { call, startHttpApp, type RunningApp } from '../helpers/http-app';

let orm: MikroORM;
let running: RunningApp;

async function metricsText(): Promise<string> {
  const response = await fetch(`${running.baseUrl}/metrics`);
  expect(response.status).toBe(200);
  return response.text();
}

function metricValue(text: string, line: string): number | undefined {
  const match = text.split('\n').find((candidate) => candidate.startsWith(line));
  return match ? Number(match.slice(line.length).trim()) : undefined;
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
});

describe('observability', () => {
  test('/health/ready reports PostgreSQL and SQS reachable', async () => {
    const response = await call(running.baseUrl, 'GET', '/health/ready');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
  });

  test('/health/ready returns 503 when SQS is unreachable, while /health/live stays 200', async () => {
    const broken = await startHttpApp({ SQS_ENDPOINT: 'http://127.0.0.1:1' });
    try {
      const ready = await call(broken.baseUrl, 'GET', '/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body.checks).toEqual({ postgres: 'up', sqs: 'down' });
      expect((await call(broken.baseUrl, 'GET', '/health/live')).status).toBe(200);
    } finally {
      await broken.close();
    }
  });

  test('/metrics exposes transactions by status, duplicates, latency and outbox backlog', async () => {
    const wallet = await call(running.baseUrl, 'POST', '/wallets', {
      body: { playerId: 'player-1', initialBalance: { amount: '100.00', currency: 'BRL' } },
    });
    const body = {
      providerId: 'provider-a',
      externalTransactionId: 'tx-metrics',
      playerId: 'player-1',
      walletId: wallet.body.id,
      roundId: 'r',
      gameId: 'g',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const headers = { 'Idempotency-Key': 'provider-a:tx-metrics' };
    const before = await metricsText();
    const processedBefore = metricValue(before, 'wagering_transactions_total{status="PROCESSED",kind="BET",source="http"}') ?? 0;
    const replaysBefore = metricValue(before, 'wagering_duplicates_detected_total{kind="idempotent_replay"}') ?? 0;

    await call(running.baseUrl, 'POST', '/wagering/transactions', { body, headers });
    await call(running.baseUrl, 'POST', '/wagering/transactions', { body, headers });

    const text = await metricsText();
    expect(metricValue(text, 'wagering_transactions_total{status="PROCESSED",kind="BET",source="http"}')).toBe(processedBefore + 1);
    expect(metricValue(text, 'wagering_duplicates_detected_total{kind="idempotent_replay"}')).toBe(replaysBefore + 1);
    expect(text).toContain('wagering_processing_duration_seconds_bucket');
    expect(text).toContain('wagering_wallet_lock_wait_seconds_bucket');
    // Publisher desligado neste teste: os eventos ficam pendentes e aparecem no backlog
    expect(metricValue(text, 'wagering_outbox_pending_messages')).toBeGreaterThan(0);
    expect(text).toContain('wagering_outbox_oldest_pending_age_seconds');
    for (const name of [
      'wagering_retries_total',
      'wagering_lock_conflicts_total',
      'wagering_messages_dead_lettered_total',
      'wagering_outbox_publish_lag_seconds',
    ]) {
      expect(text).toContain(`# TYPE ${name}`);
    }
  });
});
