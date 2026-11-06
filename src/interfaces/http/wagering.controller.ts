import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { InvalidPayloadError } from '../../application/errors';
import type { TransactionView } from '../../application/queries/views';
import { WageringQueryService } from '../../application/queries/wagering-query.service';
import {
  ProcessWagerTransactionUseCase,
  type WagerResult,
} from '../../application/wagering/process-wager-transaction.use-case';
import { WagerTransactionStatus } from '../../domain/wagering/kinds';
import { AuthGuard } from './auth/auth.guard';
import { correlationIdOf } from './correlation-id.middleware';
import { idempotencyKeySchema, parseOrThrow, uuidSchema, wagerTransactionSchema } from './validation';

const STATUS_BY_RESULT: Readonly<Record<WagerTransactionStatus, number>> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.Failed]: 500,
};

@Controller('wagering/transactions')
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase) private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(WageringQueryService) private readonly queries: WageringQueryService,
  ) {}

  @Post()
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Omit<WagerResult, 'failureCode'> & { failureCode?: string }> {
    if (idempotencyKey === undefined) {
      throw new InvalidPayloadError('Idempotency-Key header is required');
    }
    const key = parseOrThrow(idempotencyKeySchema, idempotencyKey, 'Idempotency-Key');
    const command = parseOrThrow(wagerTransactionSchema, body, 'body');

    const result = await this.processWager.execute(command, { idempotencyKey: key, correlationId: correlationIdOf(req) });
    res.status(STATUS_BY_RESULT[result.status]);
    return {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      idempotentReplay: result.idempotentReplay,
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    };
  }

  @Get(':transactionId')
  get(@Param('transactionId') transactionId: string): Promise<TransactionView> {
    return this.queries.getTransaction(parseOrThrow(uuidSchema, transactionId, 'transactionId'));
  }
}
