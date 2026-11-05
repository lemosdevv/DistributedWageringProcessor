import { WagerTransactionStatus } from '../../domain/wagering/kinds';
import type { WageringMetrics } from '../ports/metrics';
import type { StructuredLogger } from '../ports/observability';
import type { Clock } from '../ports/system';
import type { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case';

export interface PendingReferenceRepository {
  /**
   * Reivindica transações PENDING_REFERENCE vencidas, empurrando o próximo horário para
   * `now + leaseMs` (SKIP LOCKED): cada uma é reprocessada por uma única instância por vez.
   */
  claimDue(now: Date, leaseMs: number, limit: number): Promise<string[]>;
}

/** Ciclo do worker agendado do §7.1: reprocessa cada transação vencida pelo mesmo use case. */
export class PendingReferenceProcessor {
  constructor(
    private readonly repository: PendingReferenceRepository,
    private readonly useCase: ProcessWagerTransactionUseCase,
    private readonly clock: Clock,
    private readonly options: { batchSize: number; leaseMs: number },
    private readonly metrics: WageringMetrics,
    private readonly logger: StructuredLogger,
  ) {}

  async processDue(): Promise<number> {
    const ids = await this.repository.claimDue(this.clock.now(), this.options.leaseMs, this.options.batchSize);
    for (const transactionId of ids) {
      const correlationId = `pending-reference:${transactionId}`;
      try {
        const result = await this.useCase.retryPendingReference(transactionId, correlationId);
        if (result) {
          this.metrics.retry('pending_reference');
          if (result.status !== WagerTransactionStatus.PendingReference) {
            this.metrics.transactionFinished(result.status, 'reprocessed', 'pending_reference_worker');
          }
          this.logger.info(
            { correlationId, transactionId, status: result.status, failureCode: result.failureCode },
            'pending reference reprocessed',
          );
        }
      } catch (error) {
        // A lease expira e a transação volta a vencer: nada se perde
        this.logger.warn(
          { correlationId, transactionId, err: error instanceof Error ? error.message : String(error) },
          'pending reference reprocessing failed',
        );
      }
    }
    return ids.length;
  }
}
