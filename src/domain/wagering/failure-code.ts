/**
 * Taxonomia estável de falhas (§7.2). O valor é o contrato com o provider:
 * nunca renomear um código existente, apenas adicionar novos.
 */
export enum FailureCode {
  InvalidPayload = 'INVALID_PAYLOAD',
  InternalKindNotAllowed = 'INTERNAL_KIND_NOT_ALLOWED',
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  AlreadyReversed = 'ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',
}

export enum ProviderAction {
  /** Pode reenviar a mesma requisição mais tarde. */
  Retry = 'RETRY',
  /** O payload precisa ser corrigido (com nova idempotency key). */
  Correct = 'CORRECT',
  GiveUp = 'GIVE_UP',
}

export const FAILURE_CODE_ACTION: Readonly<Record<FailureCode, ProviderAction>> = {
  [FailureCode.InvalidPayload]: ProviderAction.Correct,
  [FailureCode.InternalKindNotAllowed]: ProviderAction.Correct,
  [FailureCode.WalletNotFound]: ProviderAction.Correct,
  [FailureCode.WalletPlayerMismatch]: ProviderAction.Correct,
  [FailureCode.CurrencyMismatch]: ProviderAction.Correct,
  [FailureCode.InsufficientFunds]: ProviderAction.GiveUp,
  [FailureCode.ReversalWouldOverdraw]: ProviderAction.GiveUp,
  [FailureCode.ReferenceNotFound]: ProviderAction.GiveUp,
  [FailureCode.ReferenceMismatch]: ProviderAction.Correct,
  [FailureCode.ReferenceKindNotAllowed]: ProviderAction.Correct,
  [FailureCode.ReferenceNotProcessed]: ProviderAction.GiveUp,
  [FailureCode.AlreadyReversed]: ProviderAction.GiveUp,
  [FailureCode.AmountMismatch]: ProviderAction.Correct,
  [FailureCode.IdempotencyConflict]: ProviderAction.Correct,
};
