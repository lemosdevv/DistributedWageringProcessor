import type { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { Wallet } from '../wallet/wallet';
import { FailureCode } from './failure-code';
import { LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from './kinds';
import type { WagerTransaction } from './wager-transaction';

export interface SettlementInput {
  transaction: WagerTransaction;
  /** Wallet já bloqueada pelo chamador (lock por wallet, ADR-0002). */
  wallet: Wallet;
  /** Resultado da busca por (providerId, referenceExternalTransactionId); undefined = não existe ainda. */
  reference: WagerTransaction | undefined;
  /** Já existe reversão PROCESSED do mesmo kind para essa referência. */
  referenceAlreadyReversed: boolean;
  ledgerEntryId: string;
  at: Date;
}

export type SettlementOutcome =
  | { status: WagerTransactionStatus.Processed; ledgerEntry: WalletLedgerEntry | undefined }
  | { status: WagerTransactionStatus.Rejected; failureCode: FailureCode }
  | { status: WagerTransactionStatus.PendingReference };

/** Kinds que cada operação pode referenciar (§7 regra 3; WIN/LOSS → BET da rodada). */
const ALLOWED_REFERENCE_KINDS: Readonly<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

/**
 * Aplica as regras de negócio do §7 a uma transação pendente, mutando wallet e
 * transação de forma consistente. É o único lugar que decide o efeito financeiro;
 * o use case só carrega o estado, chama esta função e persiste o resultado.
 */
export function settleWagerTransaction(input: SettlementInput): SettlementOutcome {
  const { transaction, wallet, at } = input;

  const rejection = findRejection(input);
  if (rejection === 'PENDING_REFERENCE') {
    transaction.markPendingReference();
    return { status: WagerTransactionStatus.PendingReference };
  }
  if (rejection) {
    transaction.reject(rejection, at, wallet.balance);
    return { status: WagerTransactionStatus.Rejected, failureCode: rejection };
  }

  if (!transaction.affectsBalance()) {
    transaction.markProcessed(input.reference?.id, at, wallet.balance);
    return { status: WagerTransactionStatus.Processed, ledgerEntry: undefined };
  }

  const direction = transaction.ledgerDirectionFor(input.reference);
  if (direction === LedgerDirection.Debit && !wallet.hasSufficientFunds(transaction.money)) {
    // Reversão sem saldo é operacionalmente diferente de aposta sem saldo (§7 regra 9)
    const code =
      transaction.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalWouldOverdraw;
    transaction.reject(code, at, wallet.balance);
    return { status: WagerTransactionStatus.Rejected, failureCode: code };
  }

  const movement = { money: transaction.money, transactionId: transaction.id, ledgerEntryId: input.ledgerEntryId, at };
  const ledgerEntry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
  transaction.markProcessed(input.reference?.id, at, wallet.balance);
  return { status: WagerTransactionStatus.Processed, ledgerEntry };
}

function findRejection(input: SettlementInput): FailureCode | 'PENDING_REFERENCE' | undefined {
  const { transaction, wallet, reference } = input;

  if (wallet.playerId !== transaction.playerId) {
    return FailureCode.WalletPlayerMismatch;
  }
  if (transaction.money.currency !== wallet.currency) {
    return FailureCode.CurrencyMismatch;
  }
  if (!transaction.hasReference()) {
    return undefined;
  }
  if (!reference) {
    return 'PENDING_REFERENCE';
  }
  if (!ALLOWED_REFERENCE_KINDS[transaction.kind].includes(reference.kind)) {
    return FailureCode.ReferenceKindNotAllowed;
  }
  const sameScope =
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.money.currency === transaction.money.currency &&
    reference.roundId === transaction.roundId;
  if (!sameScope) {
    return FailureCode.ReferenceMismatch;
  }
  if (!reference.isTerminal()) {
    // A referência existe mas ainda espera a própria referência: aguardar também
    return 'PENDING_REFERENCE';
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }
  if (transaction.requiresReference()) {
    // Reversão é sempre integral (§7 regra 5) e única por kind (§7 regra 4)
    if (!reference.money.equals(transaction.money)) {
      return FailureCode.AmountMismatch;
    }
    if (input.referenceAlreadyReversed) {
      return FailureCode.AlreadyReversed;
    }
  }
  return undefined;
}
