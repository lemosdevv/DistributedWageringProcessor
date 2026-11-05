import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import type { TransactionView } from '../../application/queries/views';
import { WageringQueryService } from '../../application/queries/wagering-query.service';
import { AuthGuard } from './auth/auth.guard';

@Controller('providers/:providerId/wagering/transactions')
@UseGuards(AuthGuard)
export class ProvidersController {
  constructor(@Inject(WageringQueryService) private readonly queries: WageringQueryService) {}

  @Get(':externalTransactionId')
  get(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}
