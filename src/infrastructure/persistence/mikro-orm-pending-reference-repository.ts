import type { MikroORM } from '@mikro-orm/postgresql';
import type { PendingReferenceRepository } from '../../application/wagering/pending-reference-processor';

export class MikroOrmPendingReferenceRepository implements PendingReferenceRepository {
  constructor(private readonly orm: MikroORM) {}

  async claimDue(now: Date, leaseMs: number, limit: number): Promise<string[]> {
    const rows = await this.orm.em.fork().execute<{ id: string }[]>(
      `update wager_transactions
          set next_reference_attempt_at = ?
        where id in (
          select id from wager_transactions
           where status = 'PENDING_REFERENCE' and next_reference_attempt_at <= ?
           order by next_reference_attempt_at, id
           limit ?
           for update skip locked)
        returning id`,
      [new Date(now.getTime() + leaseMs), now, limit],
    );
    return rows.map((row) => row.id);
  }
}
