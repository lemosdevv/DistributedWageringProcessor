import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface OutboxRepository {
  /**
   * Reivindica até `limit` mensagens pendentes e vencidas, empurrando o nextAttemptAt
   * para `now + leaseMs`. Publishers concorrentes nunca reivindicam a mesma linha
   * (SKIP LOCKED), e se o dono da lease morrer, a mensagem volta a vencer sozinha.
   */
  claimDue(now: Date, leaseMs: number, limit: number): Promise<OutboxMessage[]>;
  /** Marca as mensagens como publicadas num único UPDATE. */
  markPublished(messages: readonly OutboxMessage[]): Promise<void>;
  saveRetry(message: OutboxMessage): Promise<void>;
}

export interface PublishOutcome {
  /** Ids aceitos pelo broker. */
  published: string[];
  /** Ids recusados, com o motivo. */
  failed: { id: string; reason: string }[];
}

/** Destino dos eventos de integração (ADR-0004). Entrega at-least-once. */
export interface EventPublisher {
  /**
   * Publica em ordem. Mensagens do mesmo agregado mantêm a ordem relativa enviada;
   * uma falha parcial é reportada por mensagem, sem derrubar as demais.
   */
  publishAll(messages: readonly OutboxMessage[]): Promise<PublishOutcome>;
}
