import type { SQSClient } from '@aws-sdk/client-sqs';
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { OutboxPublisher } from './application/outbox/outbox-publisher';
import { MikroOrmOutboxRepository } from './infrastructure/persistence/mikro-orm-outbox-repository';
import { MikroOrmPendingReferenceRepository } from './infrastructure/persistence/mikro-orm-pending-reference-repository';
import { PendingReferenceProcessor } from './application/wagering/pending-reference-processor';
import { createSqsClient, resolveQueueUrl } from './infrastructure/sqs/sqs-client';
import { SqsConsumerHost } from './infrastructure/sqs/sqs-consumer.host';
import { SqsEventPublisher } from './infrastructure/sqs/sqs-event-publisher';
import { BackgroundWorkersHost } from './infrastructure/workers/background-workers.host';
import { PollingWorker } from './infrastructure/workers/polling-worker';
import { MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { WAGERING_METRICS, type WageringMetrics } from './application/ports/metrics';
import { PrometheusWageringMetrics } from './infrastructure/observability/prometheus-metrics';
import { ReadinessChecker } from './infrastructure/observability/readiness';
import { MetricsController } from './interfaces/http/metrics.controller';
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
  {
    provide: WAGERING_METRICS,
    inject: [MikroORM],
    useFactory: (orm: MikroORM) => new PrometheusWageringMetrics(() => outboxBacklog(orm)),
  },
  {
    provide: ReadinessChecker,
    inject: [MikroORM, SQS_CLIENT, APP_CONFIG],
    useFactory: (orm: MikroORM, sqs: SQSClient, config: AppConfig) =>
      new ReadinessChecker(orm, sqs, config.WAGER_TRANSACTIONS_QUEUE),
  },
  { provide: TRANSACTION_RUNNER, inject: [MikroORM], useFactory: (orm: MikroORM) => new MikroOrmTransactionRunner(orm) },
  { provide: WAGERING_QUERIES, inject: [MikroORM], useFactory: (orm: MikroORM) => new MikroOrmWageringQueries(orm) },
  {
    provide: ProcessWagerTransactionUseCase,
    inject: [TRANSACTION_RUNNER, CLOCK, ID_GENERATOR, WAGERING_METRICS, STRUCTURED_LOGGER],
    useFactory: (runner: TransactionRunner, clock: Clock, ids: IdGenerator, metrics: WageringMetrics, logger: StructuredLogger) =>
      new ProcessWagerTransactionUseCase(runner, clock, ids, metrics, logger),
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
  {
    provide: BackgroundWorkersHost,
    inject: [APP_CONFIG, MikroORM, SQS_CLIENT, CLOCK, WAGERING_METRICS, STRUCTURED_LOGGER, ProcessWagerTransactionUseCase],
    useFactory: async (
      config: AppConfig,
      orm: MikroORM,
      sqs: SQSClient,
      clock: Clock,
      metrics: WageringMetrics,
      logger: StructuredLogger,
      processWager: ProcessWagerTransactionUseCase,
    ) => {
      const workers: { name: string; worker: PollingWorker }[] = [];
      if (config.ENABLE_OUTBOX_PUBLISHER) {
        const eventsQueueUrl = await resolveQueueUrl(sqs, config.WALLET_EVENTS_QUEUE);
        const publisher = new OutboxPublisher(
          new MikroOrmOutboxRepository(orm),
          new SqsEventPublisher(sqs, eventsQueueUrl),
          clock,
          { batchSize: OUTBOX_BATCH_SIZE, leaseMs: OUTBOX_LEASE_MS },
          metrics,
          logger,
        );
        workers.push({
          name: 'outbox-publisher',
          worker: new PollingWorker(
            async () => (await publisher.publishBatch()).claimed > 0,
            { name: 'outbox-publisher', idleDelayMs: 250, errorDelayMs: 1_000 },
            logger,
          ),
        });
      }
      if (config.ENABLE_PENDING_REFERENCE_WORKER) {
        const processor = new PendingReferenceProcessor(
          new MikroOrmPendingReferenceRepository(orm),
          processWager,
          clock,
          { batchSize: PENDING_REFERENCE_BATCH_SIZE, leaseMs: PENDING_REFERENCE_LEASE_MS },
          metrics,
          logger,
        );
        workers.push({
          name: 'pending-reference',
          worker: new PollingWorker(
            async () => (await processor.processDue()) > 0,
            { name: 'pending-reference', idleDelayMs: 1_000, errorDelayMs: 2_000 },
            logger,
          ),
        });
      }
      return new BackgroundWorkersHost(workers, logger);
    },
  },
];

async function outboxBacklog(orm: MikroORM) {
  const [row] = await orm.em.fork().execute<{ pending: string; oldest_age: string | null }[]>(
    `select count(*)::text as pending,
            extract(epoch from (now() - min(occurred_at)))::text as oldest_age
       from outbox_messages
      where published_at is null`,
  );
  return { pending: Number(row?.pending ?? 0), oldestPendingAgeSeconds: Number(row?.oldest_age ?? 0) };
}

const PENDING_REFERENCE_BATCH_SIZE = 50;
const PENDING_REFERENCE_LEASE_MS = 30_000;

const OUTBOX_BATCH_SIZE = 100;
// Folga ampla sobre o tempo de um SendMessage: se o dono morrer, outro publica em até 30s
const OUTBOX_LEASE_MS = 30_000;

@Module({})
export class WageringModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: WageringModule,
      imports: [MikroOrmModule.forRoot(createMikroOrmConfig(config.DATABASE_URL))],
      controllers: [
        HealthController,
        MetricsController,
        ...(config.ENABLE_HTTP ? [WalletsController, WageringController, ProvidersController] : []),
      ],
      providers: [{ provide: APP_CONFIG, useValue: config }, ...applicationProviders],
    };
  }
}
