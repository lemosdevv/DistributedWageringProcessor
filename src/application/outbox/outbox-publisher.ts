import type { WageringMetrics } from '../ports/metrics';
import type { StructuredLogger } from '../ports/observability';
import type { EventPublisher, OutboxRepository } from '../ports/outbox';
import type { Clock } from '../ports/system';

export interface OutboxPublisherOptions {
  batchSize: number;
  /** Tempo de posse de uma mensagem reivindicada; maior que o pior caso de uma publicação. */
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
    let published = 0;
    let failed = 0;

    for (const message of claimed) {
      try {
        await this.publisher.publish(message);
        const now = this.clock.now();
        message.markPublished(now);
        await this.outbox.markPublished(message);
        this.metrics.outboxLag((now.getTime() - message.occurredAt.getTime()) / 1000);
        published++;
      } catch (error) {
        message.scheduleRetry(this.clock.now());
        await this.outbox.saveRetry(message);
        this.metrics.retry('outbox_publish');
        this.logger.warn(
          {
            eventId: message.id,
            eventType: message.eventType,
            attempts: message.attempts,
            err: error instanceof Error ? error.message : String(error),
          },
          'outbox publish failed, retry scheduled',
        );
        failed++;
      }
    }
    return { claimed: claimed.length, published, failed };
  }
}
