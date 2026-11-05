import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { LedgerPage } from '../../application/queries/views';
import { WageringQueryService } from '../../application/queries/wagering-query.service';
import { CreateWalletUseCase, type WalletView } from '../../application/wallets/create-wallet.use-case';
import { ReconcileWalletUseCase, type ReconciliationReport } from '../../application/wallets/reconcile-wallet.use-case';
import { AuthGuard } from './auth/auth.guard';
import { correlationIdOf } from './correlation-id.middleware';
import { createWalletSchema, ledgerQuerySchema, parseOrThrow, uuidSchema } from './validation';

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(ReconcileWalletUseCase) private readonly reconcileWallet: ReconcileWalletUseCase,
    @Inject(WageringQueryService) private readonly queries: WageringQueryService,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown, @Req() req: Request): Promise<WalletView> {
    return this.createWallet.execute(parseOrThrow(createWalletSchema, body, 'body'), correlationIdOf(req));
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.queries.getWallet(parseOrThrow(uuidSchema, walletId, 'walletId'));
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query() query: unknown): Promise<LedgerPage> {
    const { cursor, limit } = parseOrThrow(ledgerQuerySchema, query, 'query');
    return this.queries.getLedger(parseOrThrow(uuidSchema, walletId, 'walletId'), cursor, limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string, @Req() req: Request): Promise<ReconciliationReport> {
    return this.reconcileWallet.execute(parseOrThrow(uuidSchema, walletId, 'walletId'), correlationIdOf(req));
  }
}
