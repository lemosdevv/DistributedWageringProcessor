import { DomainError, InvalidWagerTransactionError } from '../../domain/errors';
import type { EventContext } from '../../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import { FailureCode } from '../../domain/wagering/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wagering/kinds';
import { settleWagerTransaction, type SettlementOutcome } from '../../domain/wagering/wager-settlement';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import { IdempotencyConflictError, InvalidPayloadError, WalletNotFoundError } from '../errors';
import type { Clock, IdGenerator } from '../ports/system';
import {
  ConcurrencyConflictError,
  DuplicateWriteError,
  type TransactionRunner,
  type WageringStore,
} from '../ports/wagering-store';
import { computePayloadHash } from './payload-hash';
import type { WagerExecutionContext, WagerTransactionCommand } from './wager-transaction-command';

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Saldo observado quando a transação terminou; ausente enquanto pendente. */
  balance: MoneyProps | undefined;
  failureCode: FailureCode | undefined;
  idempotentReplay: boolean;
}

// Corridas que o banco resolve (unique key / version) são repetidas: a nova tentativa vira replay
const MAX_ATTEMPTS = 3;

interface PreparedCommand {
  command: WagerTransactionCommand;
  money: Money;
  kind: WagerTransactionKind;
  payloadHash: string;
}

/**
 * Único caminho de processamento de uma operação de provider, usado pela API HTTP
 * e pelo consumidor SQS (§10). Inbox, transação, saldo, ledger e outbox são
 * gravados na mesma transação SQL (§6.5, §11).
 */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: WagerTransactionCommand, ctx: WagerExecutionContext): Promise<WagerResult> {
    const prepared = prepare(command);

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.transactions.run((store) => this.processInTransaction(store, prepared, ctx));
      } catch (error) {
        const retriable = error instanceof DuplicateWriteError || error instanceof ConcurrencyConflictError;
        if (!retriable || attempt >= MAX_ATTEMPTS) {
          throw error;
        }
      }
    }
  }

  private async processInTransaction(
    store: WageringStore,
    prepared: PreparedCommand,
    ctx: WagerExecutionContext,
  ): Promise<WagerResult> {
    const { command } = prepared;
    const now = this.clock.now();

    if (ctx.inbox) {
      const delivered = await store.findInboxMessage(ctx.inbox.consumerName, ctx.inbox.messageId);
      if (delivered) {
        // Redelivery de mensagem já confirmada: devolve o resultado original sem novo efeito
        return this.replayOfDelivered(store, prepared, ctx);
      }
    }

    const fastReplay = await this.findExisting(store, prepared, ctx);
    if (fastReplay) {
      return this.replayOf(fastReplay, store, ctx, now);
    }

    const wallet = await store.findWalletForUpdate(command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(command.walletId);
    }

    // Com o lock da wallet em mãos, uma duplicata concorrente já commitou: checar de novo
    const lockedReplay = await this.findExisting(store, prepared, ctx);
    if (lockedReplay) {
      return this.replayOf(lockedReplay, store, ctx, now);
    }

    const transaction = this.createTransaction(prepared, ctx, now);
    await this.settleAndPersist(store, transaction, wallet, { isNew: true, correlationId: ctx.correlationId, causationId: ctx.inbox?.messageId }, now);
    await this.recordInbox(store, prepared, ctx, now);

    return toResult(transaction, false);
  }

  /**
   * Reprocessa uma transação em PENDING_REFERENCE (§7.1), chamado pelo worker agendado.
   * Devolve undefined se outra instância já a resolveu.
   */
  async retryPendingReference(transactionId: string, correlationId: string): Promise<WagerResult | undefined> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.transactions.run(async (store) => {
          const snapshot = await store.findTransactionById(transactionId);
          if (!snapshot || snapshot.status !== WagerTransactionStatus.PendingReference) {
            return undefined;
          }
          // Mesma ordem de locks do fluxo principal: wallet primeiro, depois a releitura
          const wallet = await store.findWalletForUpdate(snapshot.walletId);
          const transaction = await store.findTransactionById(transactionId);
          if (!wallet || !transaction || transaction.status !== WagerTransactionStatus.PendingReference) {
            return undefined;
          }
          await this.settleAndPersist(store, transaction, wallet, { isNew: false, correlationId }, this.clock.now());
          return toResult(transaction, false);
        });
      } catch (error) {
        const retriable = error instanceof DuplicateWriteError || error instanceof ConcurrencyConflictError;
        if (!retriable || attempt >= MAX_ATTEMPTS) {
          throw error;
        }
      }
    }
  }

  private async settleAndPersist(
    store: WageringStore,
    transaction: WagerTransaction,
    wallet: Wallet,
    origin: { isNew: boolean; correlationId: string; causationId?: string },
    now: Date,
  ): Promise<SettlementOutcome> {
    const reference = transaction.hasReference()
      ? await store.findTransactionByExternalId(transaction.providerId, transaction.referenceExternalTransactionId!)
      : undefined;
    const referenceAlreadyReversed =
      reference !== undefined && transaction.requiresReference()
        ? await store.hasProcessedReversal(reference.id, transaction.kind)
        : false;

    const expectedVersion = wallet.version;
    const outcome = settleWagerTransaction({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      at: now,
    });

    if (origin.isNew) {
      await store.addTransaction(transaction);
    } else {
      await store.updateTransaction(transaction);
    }
    if (outcome.status === WagerTransactionStatus.Processed && outcome.ledgerEntry) {
      await store.updateWalletBalance(wallet, expectedVersion);
      await store.addLedgerEntry(outcome.ledgerEntry);
    }
    // Uma nova espera pela referência não gera evento: ele já foi publicado na primeira vez
    const stillWaiting = !origin.isNew && outcome.status === WagerTransactionStatus.PendingReference;
    if (!stillWaiting) {
      await store.addOutboxMessages(this.eventsFor(transaction, wallet, outcome, origin, now));
    }
    return outcome;
  }

  private async findExisting(
    store: WageringStore,
    prepared: PreparedCommand,
    ctx: WagerExecutionContext,
  ): Promise<WagerTransaction | undefined> {
    const byKey = await store.findTransactionByIdempotencyKey(ctx.idempotencyKey);
    const existing =
      byKey ??
      (await store.findTransactionByExternalId(prepared.command.providerId, prepared.command.externalTransactionId));
    if (!existing) {
      return undefined;
    }
    // Mesma key com outro payload, ou a mesma operação do provider sob outra key: conflito
    if (!existing.matchesPayload(prepared.payloadHash) || existing.idempotencyKey !== ctx.idempotencyKey) {
      throw new IdempotencyConflictError(ctx.idempotencyKey);
    }
    return existing;
  }

  private async replayOf(
    existing: WagerTransaction,
    store: WageringStore,
    ctx: WagerExecutionContext,
    now: Date,
  ): Promise<WagerResult> {
    if (ctx.inbox) {
      // Mensagem nova com payload já processado (ex.: reenvio pelo provider): registra para deduplicar redeliveries
      await store.addInboxMessage(
        markedInbox(ctx.inbox.consumerName, ctx.inbox.messageId, existing.payloadHash, now),
      );
    }
    return toResult(existing, true);
  }

  private async replayOfDelivered(
    store: WageringStore,
    prepared: PreparedCommand,
    ctx: WagerExecutionContext,
  ): Promise<WagerResult> {
    const existing = await this.findExisting(store, prepared, ctx);
    if (!existing) {
      // Inbox e transação são gravadas no mesmo commit: uma sem a outra indica inconsistência
      throw new Error(`Inbox message ${ctx.inbox?.messageId} has no matching transaction`);
    }
    return toResult(existing, true);
  }

  private async recordInbox(
    store: WageringStore,
    prepared: PreparedCommand,
    ctx: WagerExecutionContext,
    now: Date,
  ): Promise<void> {
    if (ctx.inbox) {
      await store.addInboxMessage(markedInbox(ctx.inbox.consumerName, ctx.inbox.messageId, prepared.payloadHash, now));
    }
  }

  private createTransaction(prepared: PreparedCommand, ctx: WagerExecutionContext, now: Date): WagerTransaction {
    const { command } = prepared;
    try {
      return WagerTransaction.create({
        id: this.ids.next(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: ctx.idempotencyKey,
        payloadHash: prepared.payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: prepared.kind,
        money: prepared.money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        createdAt: now,
      });
    } catch (error) {
      throw toInvalidPayload(error);
    }
  }

  private eventsFor(
    transaction: WagerTransaction,
    wallet: Wallet,
    outcome: SettlementOutcome,
    origin: { correlationId: string; causationId?: string },
    now: Date,
  ): OutboxMessage[] {
    const context = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: origin.correlationId,
      causationId: origin.causationId,
      occurredAt: now,
    });

    switch (outcome.status) {
      case WagerTransactionStatus.Processed: {
        const events = [OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, context()))];
        if (outcome.ledgerEntry) {
          events.push(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, outcome.ledgerEntry, context())));
        }
        return events;
      }
      case WagerTransactionStatus.Rejected:
        return [OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, context()))];
      case WagerTransactionStatus.PendingReference:
        return [OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, context()))];
    }
  }
}

function prepare(command: WagerTransactionCommand): PreparedCommand {
  let money: Money;
  try {
    money = Money.from(command.money);
  } catch (error) {
    throw toInvalidPayload(error);
  }
  const kind = command.kind as WagerTransactionKind;
  if (!Object.values(WagerTransactionKind).includes(kind)) {
    throw new InvalidPayloadError(`Unknown kind ${command.kind}`);
  }
  if (kind === WagerTransactionKind.Opening) {
    throw new InvalidPayloadError('OPENING is internal and cannot be submitted', FailureCode.InternalKindNotAllowed);
  }
  // Hash calculado sobre o valor normalizado ("25" ≡ "25.00")
  const payloadHash = computePayloadHash({ ...command, money: money.toJSON() });
  return { command, money, kind, payloadHash };
}

function toInvalidPayload(error: unknown): unknown {
  if (error instanceof InvalidWagerTransactionError) {
    return new InvalidPayloadError(error.message, error.code as FailureCode);
  }
  if (error instanceof DomainError) {
    return new InvalidPayloadError(error.message);
  }
  return error;
}

function markedInbox(consumerName: string, messageId: string, payloadHash: string, now: Date): InboxMessage {
  const inbox = InboxMessage.receive({ consumerName, messageId, payloadHash, receivedAt: now });
  inbox.markProcessed(now);
  return inbox;
}

function toResult(transaction: WagerTransaction, idempotentReplay: boolean): WagerResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.resultingBalance?.toJSON(),
    failureCode: transaction.failureCode,
    idempotentReplay,
  };
}
