import type { MoneyProps } from '../../domain/money/money';
import { WalletNotFoundError } from '../errors';
import type { WageringMetrics } from '../ports/metrics';
import type { StructuredLogger } from '../ports/observability';
import type { WageringQueries } from '../ports/wagering-queries';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compara o saldo materializado com o saldo reconstruído pelo ledger (§9).
 * Divergência nunca é corrigida aqui: é logada, contada em métrica e sinalizada.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly queries: WageringQueries,
    private readonly metrics: WageringMetrics,
    private readonly logger: StructuredLogger,
  ) {}

  async execute(walletId: string, correlationId: string): Promise<ReconciliationReport> {
    const snapshot = await this.queries.ledgerSnapshot(walletId);
    if (!snapshot) {
      throw new WalletNotFoundError(walletId);
    }

    const stored = snapshot.wallet.balance;
    const calculated = snapshot.totalCredits.subtract(snapshot.totalDebits);
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero();

    if (!consistent) {
      this.metrics.reconciliationDivergence();
      // Só valores agregados de controle; nenhum payload de transação vai para o log
      this.logger.error(
        {
          correlationId,
          walletId,
          storedBalance: stored.toString(),
          calculatedBalance: calculated.toString(),
          difference: difference.toString(),
          checkedEntries: snapshot.entries,
        },
        'wallet balance diverges from ledger',
      );
    }

    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snapshot.entries,
    };
  }
}
