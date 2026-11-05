import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import type { WageringMetrics } from '../../application/ports/metrics';

export interface OutboxBacklog {
  pending: number;
  oldestPendingAgeSeconds: number;
}

/** Métricas do §12 em formato Prometheus, expostas em GET /metrics. */
export class PrometheusWageringMetrics implements WageringMetrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Wager transactions that reached a status, by status, kind and source',
    labelNames: ['status', 'kind', 'source'],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_detected_total',
    help: 'Duplicate deliveries detected (idempotent replays, inbox redeliveries, idempotency conflicts)',
    labelNames: ['kind'],
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Retries by operation',
    labelNames: ['operation'],
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Concurrency conflicts on a wallet (version guard or unique constraint races)',
    registers: [this.registry],
  });
  private readonly lockWaitSeconds = new Histogram({
    name: 'wagering_wallet_lock_wait_seconds',
    help: 'Time spent waiting for the wallet row lock',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });
  private readonly dlq = new Counter({
    name: 'wagering_messages_dead_lettered_total',
    help: 'Messages sent to the DLQ by reason',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly processing = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'End-to-end processing latency of a wager operation by source',
    labelNames: ['source'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly outboxLagSeconds = new Histogram({
    name: 'wagering_outbox_publish_lag_seconds',
    help: 'Time between the event being committed and being published',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
    registers: [this.registry],
  });
  private readonly reconciliationDivergences = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Reconciliations where the stored balance differed from the ledger',
    registers: [this.registry],
  });

  constructor(backlog?: () => Promise<OutboxBacklog>) {
    collectDefaultMetrics({ register: this.registry });
    if (backlog) {
      // Lido do banco a cada scrape: mostra lag mesmo quando nenhum publisher está rodando
      new Gauge({
        name: 'wagering_outbox_pending_messages',
        help: 'Outbox messages not yet published',
        registers: [this.registry],
        async collect(this: Gauge) {
          this.set((await backlog()).pending);
        },
      });
      new Gauge({
        name: 'wagering_outbox_oldest_pending_age_seconds',
        help: 'Age of the oldest unpublished outbox message (outbox lag)',
        registers: [this.registry],
        async collect(this: Gauge) {
          this.set((await backlog()).oldestPendingAgeSeconds);
        },
      });
    }
  }

  transactionFinished(status: string, kind: string, source: string): void {
    this.transactions.inc({ status, kind, source });
  }

  duplicateDetected(kind: 'idempotent_replay' | 'inbox_redelivery' | 'idempotency_conflict'): void {
    this.duplicates.inc({ kind });
  }

  retry(operation: string): void {
    this.retries.inc({ operation });
  }

  lockConflict(): void {
    this.lockConflicts.inc();
  }

  lockWait(seconds: number): void {
    this.lockWaitSeconds.observe(seconds);
  }

  messageSentToDlq(reason: string): void {
    this.dlq.inc({ reason });
  }

  processingDuration(source: string, seconds: number): void {
    this.processing.observe({ source }, seconds);
  }

  outboxLag(seconds: number): void {
    this.outboxLagSeconds.observe(seconds);
  }

  reconciliationDivergence(): void {
    this.reconciliationDivergences.inc();
  }
}
