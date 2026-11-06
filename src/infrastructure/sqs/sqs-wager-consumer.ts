import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { ApplicationError } from '../../application/errors';
import type { WageringMetrics } from '../../application/ports/metrics';
import type { StructuredLogger } from '../../application/ports/observability';
import type { WagerResult } from '../../application/wagering/process-wager-transaction.use-case';
import type { WagerExecutionContext, WagerTransactionCommand } from '../../application/wagering/wager-transaction-command';
import { exponentialDelayMs } from '../../domain/shared/backoff';
import { parseWagerMessage, type ParsedWagerMessage } from './wager-message';

export interface WagerProcessor {
  execute(command: WagerTransactionCommand, ctx: WagerExecutionContext): Promise<WagerResult>;
}

export interface SqsWagerConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  consumerName: string;
  waitTimeSeconds: number;
  maxMessages: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  shutdownTimeoutMs: number;
}

export enum MessageOutcome {
  Acked = 'ACKED',
  RetryScheduled = 'RETRY_SCHEDULED',
  SentToDlq = 'SENT_TO_DLQ',
  Released = 'RELEASED',
}

/**
 * Consumidor de `wager-transactions.fifo`:
 * - deduplicação pela inbox persistente (dentro do use case), nunca em memória;
 * - ack (DeleteMessage) somente depois do commit;
 * - erro de negócio → já virou REJECTED no banco → ack;
 * - erro permanente (payload que nunca vai passar) → DLQ explícita + ack;
 * - erro transitório/inesperado → visibilidade com backoff; esgotado o maxReceiveCount
 *   da fila, o redrive do SQS move para a DLQ.
 */
export class SqsWagerConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private receiveAbort = new AbortController();

  constructor(
    private readonly sqs: SQSClient,
    private readonly processor: WagerProcessor,
    private readonly options: SqsWagerConsumerOptions,
    private readonly metrics: WageringMetrics,
    private readonly logger: StructuredLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.receiveAbort = new AbortController();
    this.loop = this.pollLoop();
  }

  /** SIGTERM: para de receber, conclui a mensagem em andamento e devolve as que não começaram. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.receiveAbort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.options.shutdownTimeoutMs);
    });
    const finished = await Promise.race([this.loop?.then(() => 'done' as const), timeout]);
    clearTimeout(timer);
    if (finished === 'timeout') {
      this.logger.warn({}, 'sqs consumer shutdown timed out with a message in flight');
    }
  }

  async pollOnce(): Promise<MessageOutcome[]> {
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: this.options.maxMessages,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: this.receiveAbort.signal },
    );

    // Grupos diferentes em paralelo; dentro de um grupo, em sequência (preserva a ordem FIFO).
    const byGroup = new Map<string, Message[]>();
    for (const message of Messages) {
      const group = message.Attributes?.MessageGroupId ?? '';
      byGroup.set(group, [...(byGroup.get(group) ?? []), message]);
    }

    const outcomes = new Map<Message, MessageOutcome>();
    await Promise.all(
      [...byGroup.values()].map(async (groupMessages) => {
        for (const message of groupMessages) {
          const accepting = this.running || this.loop === undefined;
          outcomes.set(message, accepting ? await this.handle(message) : await this.release(message));
        }
      }),
    );
    return Messages.map((message) => outcomes.get(message)!);
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.running) break;
        this.metrics.retry('sqs_receive');
        this.logger.warn({ err: describe(error) }, 'sqs receive failed, retrying');
        await Bun.sleep(1_000);
      }
    }
  }

  async handle(message: Message): Promise<MessageOutcome> {
    const startedAt = performance.now();
    let parsed: ParsedWagerMessage;
    try {
      parsed = parseWagerMessage(message.Body);
    } catch (error) {
      return this.sendToDlq(message, error, undefined);
    }

    const logContext = {
      messageId: parsed.messageId,
      correlationId: parsed.messageId,
      walletId: parsed.command.walletId,
      providerId: parsed.command.providerId,
    };

    try {
      const result = await this.processor.execute(parsed.command, {
        idempotencyKey: parsed.idempotencyKey,
        correlationId: parsed.messageId,
        inbox: { consumerName: this.options.consumerName, messageId: parsed.messageId },
      });
      await this.ack(message);
      this.metrics.processingDuration('sqs', (performance.now() - startedAt) / 1000);
      this.logger.info(
        { ...logContext, transactionId: result.transactionId, status: result.status, replay: result.idempotentReplay },
        'wager message processed',
      );
      return MessageOutcome.Acked;
    } catch (error) {
      if (error instanceof ApplicationError) {
        return this.sendToDlq(message, error, logContext);
      }
      return this.scheduleRetry(message, error, logContext);
    }
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async scheduleRetry(message: Message, error: unknown, logContext: object): Promise<MessageOutcome> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const delaySeconds = Math.round(
      exponentialDelayMs(receiveCount, {
        baseMs: this.options.retryBaseSeconds * 1000,
        capMs: this.options.retryMaxSeconds * 1000,
      }) / 1000,
    );
    this.metrics.retry('sqs_message');
    this.logger.warn({ ...logContext, receiveCount, delaySeconds, err: describe(error) }, 'wager message will be retried');
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: delaySeconds,
      }),
    );
    return MessageOutcome.RetryScheduled;
  }

  private async sendToDlq(message: Message, error: unknown, logContext: object | undefined): Promise<MessageOutcome> {
    const reason = error instanceof ApplicationError ? error.failureCode : 'UNPROCESSABLE_MESSAGE';
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.options.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureReason: { DataType: 'String', StringValue: reason },
          failureMessage: { DataType: 'String', StringValue: describe(error).message.slice(0, 1000) },
        },
      }),
    );
    // Só confirma depois de a cópia estar na DLQ: nada se perde se o processo cair no meio
    await this.ack(message);
    this.metrics.messageSentToDlq(reason);
    this.logger.error({ ...logContext, sqsMessageId: message.MessageId, reason }, 'wager message sent to DLQ');
    return MessageOutcome.SentToDlq;
  }

  private async release(message: Message): Promise<MessageOutcome> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
    return MessageOutcome.Released;
  }
}

function describe(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: 'Unknown', message: String(error) };
}
