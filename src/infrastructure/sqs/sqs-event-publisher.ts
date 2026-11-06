import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishOutcome } from '../../application/ports/outbox';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

// Limite do SQS: no máximo 10 entradas por chamada de SendMessageBatch
const SQS_BATCH_LIMIT = 10;

/**
 * MessageGroupId = aggregateId preserva a ordem por agregado; MessageDeduplicationId = eventId
 * é só otimização: a garantia de idempotência para o consumidor é o eventId do envelope.
 *
 * Os lotes saem em sequência (não em paralelo) para que eventos do mesmo agregado
 * cheguem na ordem em que foram reivindicados.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publishAll(messages: readonly OutboxMessage[]): Promise<PublishOutcome> {
    const outcome: PublishOutcome = { published: [], failed: [] };
    for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(start, start + SQS_BATCH_LIMIT);
      try {
        const response = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: chunk.map((message, index) => ({
              Id: String(index),
              MessageBody: JSON.stringify(message.payload),
              MessageGroupId: message.aggregateId,
              MessageDeduplicationId: message.id,
              MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
            })),
          }),
        );
        for (const success of response.Successful ?? []) {
          outcome.published.push(chunk[Number(success.Id)]!.id);
        }
        for (const failure of response.Failed ?? []) {
          outcome.failed.push({ id: chunk[Number(failure.Id)]!.id, reason: failure.Message ?? failure.Code ?? 'unknown' });
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        outcome.failed.push(...chunk.map((message) => ({ id: message.id, reason })));
      }
    }
    return outcome;
  }
}
