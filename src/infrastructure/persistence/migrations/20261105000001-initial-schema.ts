import { Migration } from '@mikro-orm/migrations';

// O §5.9 exige que unicidade, imutabilidade e não-negatividade sejam garantidas pelo banco, não só pelo código
export class InitialSchema20261105000001 extends Migration {
  override name = '20261105000001-initial-schema';

  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id text not null,
        currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance_amount numeric(20, 2) not null check (balance_amount >= 0),
        version integer not null check (version >= 1),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        -- no máximo uma wallet por player + moeda (§6.2)
        constraint wallets_player_currency_unique unique (player_id, currency),
        -- alvo da FK composta do ledger: garante que o lançamento usa a moeda da wallet
        constraint wallets_id_currency_unique unique (id, currency)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null references wallets (id),
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind text not null check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        status text not null check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        amount numeric(20, 2) not null check (amount >= 0),
        currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions (id),
        failure_code text,
        resulting_balance_amount numeric(20, 2) check (resulting_balance_amount >= 0),
        reference_attempts integer not null default 0 check (reference_attempts >= 0),
        next_reference_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,

        -- idempotência persistente: a key é a fonte da verdade (§9)
        constraint wager_transactions_idempotency_key_unique unique (idempotency_key),
        -- a mesma operação do provider existe uma única vez
        constraint wager_transactions_provider_external_unique unique (provider_id, external_transaction_id),
        -- alvo da FK composta do ledger: o lançamento pertence à wallet da transação
        constraint wager_transactions_id_wallet_unique unique (id, wallet_id),

        constraint wager_transactions_reference_required
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        -- só LOSS pode ter valor zero: os demais kinds movem saldo
        constraint wager_transactions_positive_amount check (amount > 0 or kind = 'LOSS'),
        constraint wager_transactions_failure_code_required
          check (status not in ('REJECTED', 'FAILED') or failure_code is not null),
        constraint wager_transactions_processed_at_required
          check (status in ('PENDING', 'PENDING_REFERENCE') or processed_at is not null)
      );
    `);

    // Uma referência não pode ser revertida duas vezes pelo mesmo kind (§7 regra 4), mesmo sob corrida
    this.addSql(`
      create unique index wager_transactions_single_reversal
        on wager_transactions (reference_transaction_id, kind)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED';
    `);
    this.addSql(`
      create index wager_transactions_pending_reference_due
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        currency char(3) not null,
        transaction_id uuid not null,
        direction text not null check (direction in ('DEBIT', 'CREDIT')),
        amount numeric(20, 2) not null check (amount > 0),
        balance_before numeric(20, 2) not null check (balance_before >= 0),
        balance_after numeric(20, 2) not null check (balance_after >= 0),
        created_at timestamptz not null,

        constraint wallet_ledger_entries_wallet_currency_fk
          foreign key (wallet_id, currency) references wallets (id, currency),
        constraint wallet_ledger_entries_transaction_wallet_fk
          foreign key (transaction_id, wallet_id) references wager_transactions (id, wallet_id),
        -- uma transação financeira gera no máximo um lançamento (§6.4)
        constraint wallet_ledger_entries_transaction_unique unique (transaction_id),
        -- aritmética do lançamento verificada pelo banco
        constraint wallet_ledger_entries_balanced check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT' and balance_after = balance_before - amount)
        )
      );
    `);
    this.addSql(`create index wallet_ledger_entries_wallet_cursor on wallet_ledger_entries (wallet_id, created_at, id);`);

    this.addSql(`
      create function wallet_ledger_entries_reject_mutation() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (% rejected)', tg_op
          using errcode = 'restrict_violation';
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_update_delete
        before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_reject_mutation();
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_entries_reject_mutation();
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        -- deduplicação persistente por (consumerName, messageId) (§10)
        constraint inbox_messages_pk primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz,
        published_at timestamptz
      );
    `);
    this.addSql(`
      create index outbox_messages_pending_due
        on outbox_messages (next_attempt_at, occurred_at)
        where published_at is null;
    `);
  }

  override down(): void {
    this.addSql('drop table if exists outbox_messages;');
    this.addSql('drop table if exists inbox_messages;');
    this.addSql('drop table if exists wallet_ledger_entries;');
    this.addSql('drop function if exists wallet_ledger_entries_reject_mutation();');
    this.addSql('drop table if exists wager_transactions;');
    this.addSql('drop table if exists wallets;');
  }
}
