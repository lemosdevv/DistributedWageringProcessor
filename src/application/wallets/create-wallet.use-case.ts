import { DomainError } from '../../domain/errors';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { InvalidPayloadError } from '../errors';
import type { Clock, IdGenerator } from '../ports/system';
import { DuplicateWriteError, type TransactionRunner } from '../ports/wagering-store';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class WalletAlreadyExistsError extends Error {
  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
    this.name = 'WalletAlreadyExistsError';
  }
}

export function toWalletView(wallet: Wallet): WalletView {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

/**
 * Cria a wallet e, quando o saldo inicial é positivo, a transação interna OPENING
 * com o lançamento CREDIT correspondente, tudo na mesma transação SQL (§9).
 */
export class CreateWalletUseCase {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand, correlationId: string): Promise<WalletView> {
    if (typeof command.playerId !== 'string' || command.playerId.trim() === '') {
      throw new InvalidPayloadError('playerId is required');
    }
    let initialBalance: Money;
    try {
      initialBalance = Money.from(command.initialBalance);
    } catch (error) {
      throw error instanceof DomainError ? new InvalidPayloadError(error.message) : error;
    }

    const now = this.clock.now();
    const walletId = this.ids.next();
    const openingTransactionId = this.ids.next();
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance,
      openingTransactionId,
      openingLedgerEntryId: this.ids.next(),
      at: now,
    });

    try {
      await this.transactions.run(async (store) => {
        await store.addWallet(wallet);
        if (!openingEntry) {
          return;
        }
        const opening = WagerTransaction.createOpening({
          id: openingTransactionId,
          walletId,
          playerId: command.playerId,
          money: initialBalance,
          createdAt: now,
        });
        await store.addTransaction(opening);
        await store.addLedgerEntry(openingEntry);
        const context = () => ({ eventId: this.ids.next(), correlationId, occurredAt: now });
        await store.addOutboxMessages([
          OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, context())),
          OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, context())),
        ]);
      });
    } catch (error) {
      if (error instanceof DuplicateWriteError && error.constraint === 'wallets_player_currency_unique') {
        throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
      }
      throw error;
    }

    return toWalletView(wallet);
  }
}
