import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports/outbox';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

/**
 * Publica na `wallet-events.fifo` (ADR-0004). MessageGroupId = aggregateId preserva a
 * ordem por agregado; MessageDeduplicationId = eventId é só otimização: a garantia de
 * idempotência para o consumidor é o eventId do envelope.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
        },
      }),
    );
  }
}
