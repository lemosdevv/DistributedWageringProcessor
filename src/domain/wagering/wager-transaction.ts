import { InvalidAmountError, InvalidTransactionStateError, InvalidWagerTransactionError } from '../errors';
import type { Money } from '../money/money';
import { exponentialDelayMs, type BackoffPolicy } from '../shared/backoff';
import { FailureCode } from './failure-code';
import {
  LedgerDirection,
  oppositeDirection,
  TERMINAL_STATUSES,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './kinds';

interface WagerTransactionIdentity {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
}

export type CreateWagerTransactionProps = WagerTransactionIdentity;

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt: Date;
}

export interface WagerTransactionState extends WagerTransactionIdentity {
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  resultingBalance: Money | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | undefined;
}

export const REFERENCE_RETRY_POLICY: BackoffPolicy = { baseMs: 2_000, capMs: 300_000 };
export const MAX_REFERENCE_ATTEMPTS = 10;

const OPENING_PROVIDER_ID = 'internal';

const REFERENCE_REQUIRED: readonly WagerTransactionKind[] = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback];

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultingBalance?: Money,
    private _referenceAttempts = 0,
    private _nextReferenceAttemptAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        FailureCode.InternalKindNotAllowed,
        'OPENING is internal and cannot be submitted',
      );
    }
    if (REFERENCE_REQUIRED.includes(props.kind) && !props.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(
        FailureCode.InvalidPayload,
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }
    const allowsZero = props.kind === WagerTransactionKind.Loss;
    if (props.money.isNegative() || (!allowsZero && props.money.isZero())) {
      throw new InvalidAmountError(`${props.kind} amount must be positive`);
    }
    return WagerTransaction.fromIdentity(props);
  }

  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    const externalId = `opening:${props.walletId}`;
    const transaction = WagerTransaction.fromIdentity({
      id: props.id,
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId: externalId,
      idempotencyKey: `${OPENING_PROVIDER_ID}:${externalId}`,
      payloadHash: externalId,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: externalId,
      gameId: OPENING_PROVIDER_ID,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      referenceExternalTransactionId: undefined,
      createdAt: props.createdAt,
    });
    transaction.markProcessed(undefined, props.createdAt, props.money);
    return transaction;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultingBalance,
      state.referenceAttempts,
      state.nextReferenceAttemptAt,
    );
  }

  private static fromIdentity(props: WagerTransactionIdentity): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date, resultingBalance: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultingBalance = resultingBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  /**
   * Entra (ou permanece) em PENDING_REFERENCE e agenda o próximo reprocessamento.
   * Cada permanência conta como uma tentativa consumida.
   */
  markPendingReference(at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.PendingReference);
    if (this._status === WagerTransactionStatus.PendingReference) {
      this._referenceAttempts += 1;
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextReferenceAttemptAt = new Date(
      at.getTime() + exponentialDelayMs(this._referenceAttempts + 1, REFERENCE_RETRY_POLICY),
    );
  }

  reject(code: FailureCode, at: Date, resultingBalance: Money | undefined): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._resultingBalance = resultingBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  canKeepWaitingForReference(): boolean {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      return true;
    }
    return this._referenceAttempts + 1 < MAX_REFERENCE_ATTEMPTS;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REFERENCE_REQUIRED.includes(this.kind);
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidWagerTransactionError(FailureCode.ReferenceNotFound, 'ROLLBACK direction needs its reference');
        }
        return oppositeDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError(FailureCode.InvalidPayload, 'LOSS does not produce a ledger entry');
    }
  }

  private assertNotTerminal(to: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, to);
    }
  }
}
