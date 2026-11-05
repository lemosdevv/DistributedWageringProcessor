import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { loadAppConfig } from '../../src/config/app-config';
import { createSqsClient } from '../../src/infrastructure/sqs/sqs-client';
import type { WagerTransactionCommand } from '../../src/application/wagering/wager-transaction-command';

export const testSqs: SQSClient = createSqsClient(loadAppConfig({}));

export interface TestQueues {
  queueUrl: string;
  dlqUrl: string;
  dispose(): Promise<void>;
}

/** Filas FIFO exclusivas por teste (com redrive real para a DLQ), isoladas da aplicação de dev. */
export async function createTestQueues(maxReceiveCount = 3, visibilityTimeout = 30): Promise<TestQueues> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { QueueUrl: dlqUrl } = await testSqs.send(
    new CreateQueueCommand({ QueueName: `test-dlq-${suffix}.fifo`, Attributes: { FifoQueue: 'true' } }),
  );
  const { Attributes } = await testSqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
  const { QueueUrl: queueUrl } = await testSqs.send(
    new CreateQueueCommand({
      QueueName: `test-wager-${suffix}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: String(visibilityTimeout),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes?.QueueArn, maxReceiveCount: String(maxReceiveCount) }),
      },
    }),
  );
  return {
    queueUrl: queueUrl!,
    dlqUrl: dlqUrl!,
    dispose: async () => {
      await testSqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      await testSqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    },
  };
}

/** Envia no formato do §10. Mesmo messageId com outro deduplicationId simula redelivery do provider. */
export async function sendWagerMessage(
  queueUrl: string,
  command: WagerTransactionCommand,
  options: { messageId?: string; deduplicationId?: string; rawBody?: string; groupId?: string } = {},
): Promise<string> {
  const messageId = options.messageId ?? `msg-${Bun.randomUUIDv7()}`;
  const body =
    options.rawBody ??
    JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: { ...command, idempotencyKey: `${command.providerId}:${command.externalTransactionId}` },
    });
  await testSqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: options.groupId ?? command.walletId,
      MessageDeduplicationId: options.deduplicationId ?? Bun.randomUUIDv7(),
    }),
  );
  return messageId;
}

export async function approximateCount(queueUrl: string): Promise<number> {
  const { Attributes } = await testSqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(Attributes?.ApproximateNumberOfMessages ?? 0) + Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

export async function drain(queueUrl: string): Promise<{ body: string; reason: string | undefined }[]> {
  const { Messages = [] } = await testSqs.send(
    new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'] }),
  );
  return Messages.map((message) => ({
    body: message.Body ?? '',
    reason: message.MessageAttributes?.failureReason?.StringValue,
  }));
}
