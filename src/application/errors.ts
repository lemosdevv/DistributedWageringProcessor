import { FailureCode } from '../domain/wagering/failure-code';

/**
 * Erros da camada de aplicação que não viram transação persistida:
 * o provider recebe o failureCode e decide o que fazer.
 */
export abstract class ApplicationError extends Error {
  abstract readonly failureCode: FailureCode;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Mesma idempotency key (ou mesma operação do provider) com payload diferente: conflito, não replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly failureCode = FailureCode.IdempotencyConflict;

  constructor(idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was already used with a different payload`);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly failureCode = FailureCode.WalletNotFound;

  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

/** Payload que não forma uma transação válida (dinheiro, kind, referência obrigatória…). */
export class InvalidPayloadError extends ApplicationError {
  readonly failureCode: FailureCode;

  constructor(message: string, failureCode: FailureCode = FailureCode.InvalidPayload) {
    super(message);
    this.failureCode = failureCode;
  }
}

export class WagerTransactionNotFoundError extends Error {
  constructor(description: string) {
    super(`Wager transaction ${description} not found`);
    this.name = 'WagerTransactionNotFoundError';
  }
}
