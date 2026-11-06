import type { WageringMetrics } from '../ports/metrics';
import type { StructuredLogger } from '../ports/observability';
import type { EventPublisher, OutboxRepository } from '../ports/outbox';
import type { Clock } from '../ports/system';

export interface OutboxPublisherOptions {
  batchSize: number;
  /** Tempo de posse de uma mensagem reivindicada; maior que o pior caso de publicar um lote. */
  leaseMs: number;
}

export interface PublishBatchResult {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Publica eventos da outbox depois do commit (§11). Seguro com N publishers:
 * cada mensagem é reivindicada por um só; se ele morrer antes de marcar como
 * publicada, a lease expira e outro publica de novo (at-least-once, deduplicável pelo eventId).
 */
export class OutboxPublisher {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly options: OutboxPublisherOptions,
    private readonly metrics: WageringMetrics,
    private readonly logger: StructuredLogger,
  ) {}

  async publishBatch(): Promise<PublishBatchResult> {
    const claimed = await this.outbox.claimDue(this.clock.now(), this.options.leaseMs, this.options.batchSize);
    if (claimed.length === 0) {
      return { claimed: 0, published: 0, failed: 0 };
    }

    let outcome;
    try {
      outcome = await this.publisher.publishAll(claimed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      outcome = { published: [], failed: claimed.map((message) => ({ id: message.id, reason })) };
    }

    const now = this.clock.now();
    const publishedIds = new Set(outcome.published);
    const published = claimed.filter((message) => publishedIds.has(message.id));
    for (const message of published) {
      message.markPublished(now);
      this.metrics.outboxLag((now.getTime() - message.occurredAt.getTime()) / 1000);
    }
    // Só marca depois de o broker aceitar: se o processo cair aqui, a lease expira e republica
    await this.outbox.markPublished(published);

    const failures = new Map(outcome.failed.map((failure) => [failure.id, failure.reason]));
    for (const message of claimed) {
      const reason = failures.get(message.id);
      if (reason === undefined) continue;
      message.scheduleRetry(now);
      await this.outbox.saveRetry(message);
      this.metrics.retry('outbox_publish');
      this.logger.warn(
        { eventId: message.id, eventType: message.eventType, attempts: message.attempts, err: reason },
        'outbox publish failed, retry scheduled',
      );
    }

    return { claimed: claimed.length, published: published.length, failed: failures.size };
  }
}
