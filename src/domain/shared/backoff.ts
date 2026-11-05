export interface BackoffPolicy {
  baseMs: number;
  capMs: number;
}

/** Atraso exponencial para a tentativa N (1-based): base, 2×base, 4×base… limitado ao teto. */
export function exponentialDelayMs(attempt: number, policy: BackoffPolicy): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(policy.capMs, policy.baseMs * 2 ** exponent);
}
