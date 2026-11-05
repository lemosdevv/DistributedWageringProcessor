import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface OutboxRepository {
  /**
   * Reivindica até `limit` mensagens pendentes e vencidas, empurrando o nextAttemptAt
   * para `now + leaseMs`. Publishers concorrentes nunca reivindicam a mesma linha
   * (SKIP LOCKED), e se o dono da lease morrer, a mensagem volta a vencer sozinha.
   */
  claimDue(now: Date, leaseMs: number, limit: number): Promise<OutboxMessage[]>;
  markPublished(message: OutboxMessage): Promise<void>;
  saveRetry(message: OutboxMessage): Promise<void>;
}

/** Destino dos eventos de integração (ADR-0004). Entrega at-least-once. */
export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}
