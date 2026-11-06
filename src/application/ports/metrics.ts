export interface WageringMetrics {
  transactionFinished(status: string, kind: string, source: string): void;
  duplicateDetected(kind: 'idempotent_replay' | 'inbox_redelivery' | 'idempotency_conflict'): void;
  retry(operation: string): void;
  lockConflict(): void;
  lockWait(seconds: number): void;
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
  lockWait: () => {},
  messageSentToDlq: () => {},
  processingDuration: () => {},
  outboxLag: () => {},
  reconciliationDivergence: () => {},
};
