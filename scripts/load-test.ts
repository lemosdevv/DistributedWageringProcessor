/**
 * Teste de carga (diferencial opcional do §14): `bun run test:load`.
 *
 * Sobe N instâncias reais da aplicação contra um banco próprio (`wagering_load`) e filas
 * próprias, gera carga mista por HTTP e por SQS sobre muitas wallets e uma wallet muito
 * disputada, e mede throughput, latência, erros, conflitos e outbox lag. No fim confere
 * a consistência de todas as wallets e grava o relatório em docs/load-test/results.md.
 */
import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { cpus, platform, release, totalmem } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { createOrmFor, databaseUrlFor, resetDatabase, sql } from '../test/helpers/database';
import { eventually, spawnInstance, type AppInstance } from '../test/helpers/instances';
import { approximateCount, createTestQueues, testSqs } from '../test/helpers/sqs';
import { buildUseCases } from '../test/helpers/wagering';

const settings = {
  instances: Number(process.env.LOAD_INSTANCES ?? 3),
  httpRequests: Number(process.env.LOAD_HTTP_REQUESTS ?? 5000),
  concurrency: Number(process.env.LOAD_CONCURRENCY ?? 50),
  sqsMessages: Number(process.env.LOAD_SQS_MESSAGES ?? 2000),
  wallets: Number(process.env.LOAD_WALLETS ?? 50),
};
const DATABASE = 'wagering_load';

// ---------- utilidades estatísticas

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((total, value) => total + value, 0) / Math.max(1, sorted.length);
  return {
    count: sorted.length,
    mean,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
  };
}

const ms = (value: number) => `${value.toFixed(1)} ms`;
const pct = (part: number, total: number) => `${((100 * part) / Math.max(1, total)).toFixed(2)}%`;
const randomInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

// ---------- métricas Prometheus das instâncias

async function scrapeTotals(instances: AppInstance[]) {
  const totals = new Map<string, number>();
  for (const instance of instances) {
    const text = await (await fetch(`${instance.baseUrl}/metrics`)).text();
    for (const line of text.split('\n')) {
      if (line.startsWith('#') || !line.startsWith('wagering_')) continue;
      const [series, value] = [line.slice(0, line.lastIndexOf(' ')), Number(line.slice(line.lastIndexOf(' ') + 1))];
      totals.set(series, (totals.get(series) ?? 0) + value);
    }
  }
  const sum = (prefix: string) =>
    [...totals.entries()].filter(([series]) => series.startsWith(prefix)).reduce((total, [, value]) => total + value, 0);
  return {
    lockConflicts: sum('wagering_lock_conflicts_total'),
    retries: sum('wagering_retries_total'),
    replays: sum('wagering_duplicates_detected_total{kind="idempotent_replay"}'),
    inboxRedeliveries: sum('wagering_duplicates_detected_total{kind="inbox_redelivery"}'),
    dlq: sum('wagering_messages_dead_lettered_total'),
    lockWaitSum: sum('wagering_wallet_lock_wait_seconds_sum'),
    lockWaitCount: sum('wagering_wallet_lock_wait_seconds_count'),
  };
}

// ---------- execução

async function main(): Promise<void> {
  const orm = await createOrmFor(DATABASE);
  await resetDatabase(orm);
  const wagerQueues = await createTestQueues(5, 30);
  const eventQueues = await createTestQueues();
  const instances: AppInstance[] = [];

  try {
    console.log(`[load] starting ${settings.instances} instances`);
    instances.push(
      ...(await Promise.all(
        Array.from({ length: settings.instances }, (_, i) =>
          spawnInstance(
            `load-${i}`,
            4201 + i,
            { wagerQueue: wagerQueues.queueUrl, wagerDlq: wagerQueues.dlqUrl, eventsQueue: eventQueues.queueUrl },
            { databaseUrl: databaseUrlFor(DATABASE), env: { LOG_LEVEL: 'error', SQS_WAIT_TIME_SECONDS: '2' } },
          ),
        ),
      )),
    );

    // Wallets: muitas com saldo folgado e uma "hot wallet" com saldo curto (disputa + rejeições)
    const useCases = buildUseCases(orm);
    const wallets: { id: string; playerId: string }[] = [];
    for (let i = 0; i < settings.wallets; i++) {
      const playerId = `load-player-${i}`;
      const wallet = await useCases.createWallet.execute(
        { playerId, initialBalance: { amount: '1000000.00', currency: 'BRL' } },
        'load',
      );
      wallets.push({ id: wallet.id, playerId });
    }
    const hot = await useCases.createWallet.execute(
      { playerId: 'load-hot-player', initialBalance: { amount: '500.00', currency: 'BRL' } },
      'load',
    );
    const hotWallet = { id: hot.id, playerId: 'load-hot-player' };

    let sequence = 0;
    const operation = (wallet: { id: string; playerId: string }, kind: string, amount: string) => ({
      providerId: 'provider-load',
      externalTransactionId: `load-${++sequence}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${sequence}`,
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
    });

    // ---------- fase 1: HTTP
    // Mix: 75% BET em wallet aleatória, 10% WIN, 10% BET na hot wallet, 5% reenvio idêntico (replay)
    const httpPlan: ReturnType<typeof operation>[] = [];
    for (let i = 0; i < settings.httpRequests; i++) {
      const roll = Math.random();
      if (roll < 0.05 && httpPlan.length > 0) {
        httpPlan.push(httpPlan[randomInt(0, httpPlan.length - 1)]!);
      } else if (roll < 0.15) {
        httpPlan.push(operation(hotWallet, 'BET', '10.00'));
      } else if (roll < 0.25) {
        httpPlan.push(operation(wallets[randomInt(0, wallets.length - 1)]!, 'WIN', `${randomInt(1, 50)}.00`));
      } else {
        httpPlan.push(operation(wallets[randomInt(0, wallets.length - 1)]!, 'BET', `${randomInt(1, 20)}.${randomInt(10, 99)}`));
      }
    }

    const httpLatencies: number[] = [];
    const httpStatuses = new Map<number, number>();
    let networkErrors = 0;
    let cursor = 0;
    console.log(`[load] http phase: ${settings.httpRequests} requests, concurrency ${settings.concurrency}`);
    const httpStartedAt = performance.now();
    await Promise.all(
      Array.from({ length: settings.concurrency }, async (_, worker) => {
        while (cursor < httpPlan.length) {
          const index = cursor++;
          const body = httpPlan[index]!;
          const instance = instances[(index + worker) % instances.length]!;
          const startedAt = performance.now();
          try {
            const response = await fetch(`${instance.baseUrl}/wagering/transactions`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}`,
              },
              body: JSON.stringify(body),
            });
            await response.arrayBuffer();
            httpStatuses.set(response.status, (httpStatuses.get(response.status) ?? 0) + 1);
          } catch {
            networkErrors++;
          }
          httpLatencies.push(performance.now() - startedAt);
        }
      }),
    );
    const httpSeconds = (performance.now() - httpStartedAt) / 1000;

    // ---------- fase 2: SQS
    // Mensagens agrupadas por wallet (como um provedor real faria); 10% reentregues com o mesmo messageId
    console.log(`[load] sqs phase: ${settings.sqsMessages} messages`);
    const sentAt = new Map<string, number>();
    const entries = Array.from({ length: settings.sqsMessages }, () => {
      const wallet = wallets[randomInt(0, wallets.length - 1)]!;
      const body = operation(wallet, 'BET', `${randomInt(1, 20)}.00`);
      return { body, messageId: `msg-${body.externalTransactionId}` };
    });
    const withRedeliveries = [...entries, ...entries.filter(() => Math.random() < 0.1)];
    const sqsStartedAt = performance.now();
    for (let i = 0; i < withRedeliveries.length; i += 10) {
      const batch = withRedeliveries.slice(i, i + 10);
      await testSqs.send(
        new SendMessageBatchCommand({
          QueueUrl: wagerQueues.queueUrl,
          Entries: batch.map(({ body, messageId }, j) => {
            if (!sentAt.has(body.externalTransactionId)) sentAt.set(body.externalTransactionId, Date.now());
            return {
              Id: `e${j}`,
              MessageGroupId: body.walletId,
              MessageDeduplicationId: `${messageId}-${i}-${j}`,
              MessageBody: JSON.stringify({
                messageId,
                type: 'WagerTransactionRequested',
                occurredAt: new Date().toISOString(),
                data: { ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}` },
              }),
            };
          }),
        }),
      );
    }
    const sqsIds = [...sentAt.keys()];
    // Ids como texto único: o driver expandiria um array em `?` como lista separada por vírgulas
    const idsParam = sqsIds.join(',');
    const BY_IDS = "external_transaction_id = any(string_to_array(?, ','))";
    await eventually(
      async () => Number((await sql<{ count: string }>(orm, `select count(*) from wager_transactions where ${BY_IDS}`, [idsParam]))[0]?.count),
      (count) => count === sqsIds.length,
      600_000,
    );
    await eventually(() => approximateCount(wagerQueues.queueUrl), (count) => count === 0, 600_000);
    const sqsSeconds = (performance.now() - sqsStartedAt) / 1000;
    const sqsRows = await sql<{ external_transaction_id: string; created_at: Date }>(
      orm,
      `select external_transaction_id, created_at from wager_transactions where ${BY_IDS}`,
      [idsParam],
    );
    const sqsLatencies = sqsRows.map((row) => new Date(row.created_at).getTime() - sentAt.get(row.external_transaction_id)!);

    // ---------- fase 3: outbox
    const drainStartedAt = performance.now();
    await eventually(
      async () => Number((await sql<{ count: string }>(orm, 'select count(*) from outbox_messages where published_at is null'))[0]?.count),
      (count) => count === 0,
      600_000,
    );
    const drainSeconds = (performance.now() - drainStartedAt) / 1000;
    const outboxLags = (
      await sql<{ lag_ms: string }>(
        orm,
        'select extract(epoch from (published_at - occurred_at)) * 1000 as lag_ms from outbox_messages',
      )
    ).map((row) => Number(row.lag_ms));

    // ---------- consistência e métricas
    const metrics = await scrapeTotals(instances);
    const [consistency] = await sql<{ wallets: string; inconsistent: string; negative: string }>(
      orm,
      `select count(*) as wallets,
              count(*) filter (where w.balance_amount <> coalesce(l.rebuilt, 0)) as inconsistent,
              count(*) filter (where w.balance_amount < 0) as negative
         from wallets w
         left join (select wallet_id, sum(case when direction = 'CREDIT' then amount else -amount end) as rebuilt
                      from wallet_ledger_entries group by wallet_id) l on l.wallet_id = w.id`,
    );
    const [duplicates] = await sql<{ count: string }>(
      orm,
      `select count(*) from (select 1 from wager_transactions group by provider_id, external_transaction_id having count(*) > 1) d`,
    );
    const statuses = await sql<{ status: string; failure_code: string | null; count: string }>(
      orm,
      `select status, failure_code, count(*) from wager_transactions where kind <> 'OPENING' group by 1, 2 order by 3 desc`,
    );
    const hotReconciliation = (await (
      await fetch(`${instances[0]!.baseUrl}/wallets/${hotWallet.id}/reconciliation`, { method: 'POST' })
    ).json()) as { consistent?: boolean; storedBalance?: { amount: string } };

    // ---------- relatório
    const http = summary(httpLatencies);
    const sqs = summary(sqsLatencies);
    const lag = summary(outboxLags);
    const totalHttp = httpLatencies.length;
    const serverErrors = [...httpStatuses.entries()].filter(([status]) => status >= 500).reduce((t, [, c]) => t + c, 0);
    const cpu = cpus();

    const report = `# Resultados do teste de carga

> Gerado por \`bun run test:load\` em ${new Date().toISOString()}. Os números dependem da máquina; o objetivo é a metodologia e a verificação de consistência sob carga, não um alvo de RPS.

## Ambiente

| Item | Valor |
|---|---|
| Sistema | ${platform()} ${release()} |
| CPU | ${cpu[0]?.model.trim()} (${cpu.length} threads lógicas) |
| Memória | ${(totalmem() / 1024 ** 3).toFixed(1)} GiB |
| Runtime | Bun ${Bun.version} |
| PostgreSQL | postgres:17-alpine (Docker) |
| SQS | LocalStack 4.9 (Docker) |
| Instâncias da aplicação | ${settings.instances} processos locais, cada um com API, consumidor, publisher e worker |

Gerador de carga, instâncias e containers rodam **na mesma máquina** e disputam CPU entre si.

## Metodologia

- Banco próprio (\`${DATABASE}\`) recriado pelas migrations; filas SQS próprias.
- ${settings.wallets} wallets com saldo de 1.000.000,00 BRL e 1 *hot wallet* com 500,00 BRL.
- **Fase HTTP:** ${settings.httpRequests} requisições com ${settings.concurrency} clientes concorrentes, distribuídas entre as instâncias. Mix: ~75% BET em wallet aleatória, ~10% WIN, ~10% BET de 10,00 na hot wallet (disputa pelo mesmo lock e rejeições por saldo depois de 50 apostas), ~5% reenvio idêntico (replay).
- **Fase SQS:** ${settings.sqsMessages} mensagens (BET em wallet aleatória, \`MessageGroupId\` = wallet), mais ~10% reentregues com o mesmo \`messageId\`. A latência é medida do envio até o \`created_at\` da transação no banco.
- **Outbox:** lag por evento = \`published_at - occurred_at\`, calculado no banco para todos os eventos.
- Latência HTTP medida no cliente (inclui rede local e serialização).

## Resultados

### HTTP

| Métrica | Valor |
|---|---|
| Requisições | ${totalHttp} em ${httpSeconds.toFixed(1)} s |
| Throughput | **${(totalHttp / httpSeconds).toFixed(1)} req/s** |
| Latência p50 / p95 / p99 | ${ms(http.p50)} / ${ms(http.p95)} / ${ms(http.p99)} (máx. ${ms(http.max)}) |
| Status | ${[...httpStatuses.entries()].sort().map(([status, count]) => `${status}: ${count}`).join(' · ')} |
| Taxa de erro (5xx + falhas de rede) | **${pct(serverErrors + networkErrors, totalHttp)}** (${serverErrors + networkErrors}) |

Os 422 são rejeições de negócio esperadas (saldo insuficiente na hot wallet), não erros.

### SQS

| Métrica | Valor |
|---|---|
| Mensagens | ${withRedeliveries.length} enviadas (${sqsIds.length} operações distintas) em ${sqsSeconds.toFixed(1)} s |
| Throughput | **${(sqsIds.length / sqsSeconds).toFixed(1)} operações/s** |
| Latência envio → commit p50 / p95 / p99 | ${ms(sqs.p50)} / ${ms(sqs.p95)} / ${ms(sqs.p99)} (máx. ${ms(sqs.max)}) |
| Mensagens na DLQ | ${metrics.dlq} |

### Concorrência e duplicatas

| Métrica | Valor |
|---|---|
| Conflitos de concorrência (retries por corrida) | ${metrics.lockConflicts} |
| Retries (todas as operações) | ${metrics.retries} |
| Espera média pelo lock da wallet | ${ms((1000 * metrics.lockWaitSum) / Math.max(1, metrics.lockWaitCount))} em ${metrics.lockWaitCount} aquisições |
| Replays idempotentes detectados | ${metrics.replays} |
| Reentregas barradas pela inbox | ${metrics.inboxRedeliveries} |

### Outbox

| Métrica | Valor |
|---|---|
| Eventos publicados | ${lag.count} |
| Lag p50 / p95 / p99 | ${ms(lag.p50)} / ${ms(lag.p95)} / ${ms(lag.p99)} (máx. ${ms(lag.max)}) |
| Tempo para drenar após o fim da carga | ${drainSeconds.toFixed(1)} s |

### Consistência final

| Verificação | Resultado |
|---|---|
| Wallets com saldo ≠ ledger | **${consistency?.inconsistent}** de ${consistency?.wallets} |
| Wallets com saldo negativo | **${consistency?.negative}** |
| Operações do provedor duplicadas | **${duplicates?.count}** |
| Reconciliação da hot wallet | consistent: ${hotReconciliation.consistent}, saldo ${hotReconciliation.storedBalance?.amount} |

Transações por status:

| Status | failureCode | Quantidade |
|---|---|---|
${statuses.map((row) => `| ${row.status} | ${row.failure_code ?? '—'} | ${row.count} |`).join('\n')}
`;

    await mkdir('docs/load-test', { recursive: true });
    await Bun.write('docs/load-test/results.md', report);
    console.log(report);

    if (Number(consistency?.inconsistent) > 0 || Number(consistency?.negative) > 0 || Number(duplicates?.count) > 0) {
      throw new Error('consistency check failed under load');
    }
  } finally {
    await Promise.all(instances.map((instance) => instance.stop()));
    await wagerQueues.dispose();
    await eventQueues.dispose();
    await orm.close(true);
  }
}

await main();
