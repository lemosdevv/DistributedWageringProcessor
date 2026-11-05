import type { SQSClient } from '@aws-sdk/client-sqs';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import type { WageringMetrics } from '../../application/ports/metrics';
import type { StructuredLogger } from '../../application/ports/observability';
import type { AppConfig } from '../../config/app-config';
import { resolveQueueUrl } from './sqs-client';
import { SqsWagerConsumer, type WagerProcessor } from './sqs-wager-consumer';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

/** Liga o ciclo de vida do consumidor ao da aplicação Nest (start no boot, stop no SIGTERM). */
export class SqsConsumerHost implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private consumer: SqsWagerConsumer | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly processor: WagerProcessor,
    private readonly config: AppConfig,
    private readonly metrics: WageringMetrics,
    private readonly logger: StructuredLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.ENABLE_SQS_CONSUMER) return;
    const [queueUrl, dlqUrl] = await Promise.all([
      resolveQueueUrl(this.sqs, this.config.WAGER_TRANSACTIONS_QUEUE),
      resolveQueueUrl(this.sqs, this.config.WAGER_TRANSACTIONS_DLQ),
    ]);
    this.consumer = new SqsWagerConsumer(
      this.sqs,
      this.processor,
      {
        queueUrl,
        dlqUrl,
        consumerName: WAGER_CONSUMER_NAME,
        waitTimeSeconds: this.config.SQS_WAIT_TIME_SECONDS,
        maxMessages: 10,
        retryBaseSeconds: this.config.SQS_RETRY_BASE_SECONDS,
        retryMaxSeconds: this.config.SQS_RETRY_MAX_SECONDS,
        shutdownTimeoutMs: this.config.SHUTDOWN_TIMEOUT_MS,
      },
      this.metrics,
      this.logger,
    );
    this.consumer.start();
    this.logger.info({ queue: this.config.WAGER_TRANSACTIONS_QUEUE }, 'sqs consumer started');
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (!this.consumer) return;
    this.logger.info({ signal }, 'stopping sqs consumer');
    await this.consumer.stop();
  }
}
