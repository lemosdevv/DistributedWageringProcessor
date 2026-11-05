/**
 * Métricas mínimas do §12 mais a divergência de reconciliação (§9). A implementação
 * fica na infraestrutura (Prometheus); a aplicação só conhece esta porta.
 */
export interface WageringMetrics {
  transactionFinished(status: string, kind: string, source: string): void;
  duplicateDetected(kind: 'idempotent_replay' | 'inbox_redelivery' | 'idempotency_conflict'): void;
  retry(operation: string): void;
  lockConflict(): void;
  messageSentToDlq(reason: string): void;
  processingDuration(source: string, seconds: number): void;
  outboxLag(seconds: number): void;
  reconciliationDivergence(): void;
}

export const WAGERING_METRICS = Symbol('WAGERING_METRICS');

export const noopMetrics: WageringMetrics = {
  transactionFinished: () => {},
  duplicateDetected: () => {},
  retry: () => {},
  lockConflict: () => {},
  messageSentToDlq: () => {},
  processingDuration: () => {},
  outboxLag: () => {},
  reconciliationDivergence: () => {},
};
