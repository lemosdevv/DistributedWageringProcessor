import type { SQSClient } from '@aws-sdk/client-sqs';
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { createSqsClient } from './infrastructure/sqs/sqs-client';
import { SqsConsumerHost } from './infrastructure/sqs/sqs-consumer.host';
import { MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { noopMetrics, WAGERING_METRICS, type WageringMetrics } from './application/ports/metrics';
import { STRUCTURED_LOGGER, type StructuredLogger } from './application/ports/observability';
import { CLOCK, ID_GENERATOR, systemClock, uuidV7Generator, type Clock, type IdGenerator } from './application/ports/system';
import { WAGERING_QUERIES, type WageringQueries } from './application/ports/wagering-queries';
import { TRANSACTION_RUNNER, type TransactionRunner } from './application/ports/wagering-store';
import { WageringQueryService } from './application/queries/wagering-query.service';
import { ProcessWagerTransactionUseCase } from './application/wagering/process-wager-transaction.use-case';
import { CreateWalletUseCase } from './application/wallets/create-wallet.use-case';
import { ReconcileWalletUseCase } from './application/wallets/reconcile-wallet.use-case';
import { APP_CONFIG, type AppConfig } from './config/app-config';
import { createPinoLogger, PinoStructuredLogger } from './infrastructure/observability/pino-logger';
import { createMikroOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmWageringQueries } from './infrastructure/persistence/mikro-orm-wagering-queries';
import { MikroOrmTransactionRunner } from './infrastructure/persistence/mikro-orm-wagering-store';
import { AuthGuard } from './interfaces/http/auth/auth.guard';
import { HealthController } from './interfaces/http/health.controller';
import { ProvidersController } from './interfaces/http/providers.controller';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

/*
 * Composição da aplicação. Use cases são classes puras (sem decorators do Nest):
 * são montados aqui por factories, o que mantém application/ e domain/ independentes do framework.
 */
const applicationProviders: Provider[] = [
  { provide: CLOCK, useValue: systemClock },
  { provide: ID_GENERATOR, useValue: uuidV7Generator },
  {
    provide: STRUCTURED_LOGGER,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig) => new PinoStructuredLogger(createPinoLogger(config.LOG_LEVEL)),
  },
  { provide: WAGERING_METRICS, useValue: noopMetrics },
  { provide: TRANSACTION_RUNNER, inject: [MikroORM], useFactory: (orm: MikroORM) => new MikroOrmTransactionRunner(orm) },
  { provide: WAGERING_QUERIES, inject: [MikroORM], useFactory: (orm: MikroORM) => new MikroOrmWageringQueries(orm) },
  {
    provide: ProcessWagerTransactionUseCase,
    inject: [TRANSACTION_RUNNER, CLOCK, ID_GENERATOR],
    useFactory: (runner: TransactionRunner, clock: Clock, ids: IdGenerator) =>
      new ProcessWagerTransactionUseCase(runner, clock, ids),
  },
  {
    provide: CreateWalletUseCase,
    inject: [TRANSACTION_RUNNER, CLOCK, ID_GENERATOR],
    useFactory: (runner: TransactionRunner, clock: Clock, ids: IdGenerator) => new CreateWalletUseCase(runner, clock, ids),
  },
  {
    provide: ReconcileWalletUseCase,
    inject: [WAGERING_QUERIES, WAGERING_METRICS, STRUCTURED_LOGGER],
    useFactory: (queries: WageringQueries, metrics: WageringMetrics, logger: StructuredLogger) =>
      new ReconcileWalletUseCase(queries, metrics, logger),
  },
  {
    provide: WageringQueryService,
    inject: [WAGERING_QUERIES],
    useFactory: (queries: WageringQueries) => new WageringQueryService(queries),
  },
  AuthGuard,
  { provide: SQS_CLIENT, inject: [APP_CONFIG], useFactory: (config: AppConfig) => createSqsClient(config) },
  {
    provide: SqsConsumerHost,
    inject: [SQS_CLIENT, ProcessWagerTransactionUseCase, APP_CONFIG, WAGERING_METRICS, STRUCTURED_LOGGER],
    useFactory: (
      sqs: SQSClient,
      processor: ProcessWagerTransactionUseCase,
      config: AppConfig,
      metrics: WageringMetrics,
      logger: StructuredLogger,
    ) => new SqsConsumerHost(sqs, processor, config, metrics, logger),
  },
];

@Module({})
export class WageringModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: WageringModule,
      imports: [MikroOrmModule.forRoot(createMikroOrmConfig(config.DATABASE_URL))],
      controllers: [
        HealthController,
        ...(config.ENABLE_HTTP ? [WalletsController, WageringController, ProvidersController] : []),
      ],
      providers: [{ provide: APP_CONFIG, useValue: config }, ...applicationProviders],
    };
  }
}
