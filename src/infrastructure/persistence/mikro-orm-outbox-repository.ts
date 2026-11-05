import type { MikroORM } from '@mikro-orm/postgresql';
import type { OutboxRepository } from '../../application/ports/outbox';
import { OutboxMessage } from '../../domain/messaging/outbox-message';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string | null;
  published_at: Date | string | null;
}

const toDate = (value: Date | string) => (value instanceof Date ? value : new Date(value));

function rowToDomain(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    occurredAt: toDate(row.occurred_at),
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at ? toDate(row.next_attempt_at) : undefined,
    publishedAt: row.published_at ? toDate(row.published_at) : undefined,
  });
}

/*
 * SQL explícito: o claim precisa de UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)
 * RETURNING numa única instrução, o que garante que dois publishers nunca peguem a mesma linha
 * e que nenhuma transação fique aberta durante a chamada de rede ao SQS.
 */
export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly orm: MikroORM) {}

  async claimDue(now: Date, leaseMs: number, limit: number): Promise<OutboxMessage[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const rows = await this.orm.em.fork().execute<OutboxRow[]>(
      `update outbox_messages
          set next_attempt_at = ?
        where id in (
          select id from outbox_messages
           where published_at is null and next_attempt_at <= ?
           order by occurred_at, id
           limit ?
           for update skip locked)
        returning *`,
      [leaseUntil, now, limit],
    );
    // A ordem de publicação segue a ordem de ocorrência (o RETURNING não garante ordem)
    return rows.map(rowToDomain).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.orm.em.fork().execute(
      'update outbox_messages set published_at = ?, next_attempt_at = null where id = ? and published_at is null',
      [message.publishedAt, message.id],
    );
  }

  async saveRetry(message: OutboxMessage): Promise<void> {
    await this.orm.em.fork().execute(
      'update outbox_messages set attempts = ?, next_attempt_at = ? where id = ? and published_at is null',
      [message.attempts, message.nextAttemptAt, message.id],
    );
  }
}
