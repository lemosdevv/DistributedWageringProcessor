import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config/app-config';

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.AWS_REGION,
    endpoint: config.SQS_ENDPOINT,
    credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
  });
}

export async function resolveQueueUrl(client: SQSClient, queueName: string): Promise<string> {
  const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (!QueueUrl) {
    throw new Error(`Queue ${queueName} not found`);
  }
  return QueueUrl;
}
