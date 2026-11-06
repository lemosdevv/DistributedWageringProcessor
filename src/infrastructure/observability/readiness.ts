import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { resolveQueueUrl } from '../sqs/sqs-client';

export type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  checks: { postgres: DependencyStatus; sqs: DependencyStatus };
}

const CHECK_TIMEOUT_MS = 2_000;

async function withTimeout(check: () => Promise<unknown>): Promise<DependencyStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
      }),
    ]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

export class ReadinessChecker {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  async check(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([
      withTimeout(() => this.orm.em.fork().execute('select 1')),
      withTimeout(async () => {
        const queueUrl = await resolveQueueUrl(this.sqs, this.queueName);
        await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }));
      }),
    ]);
    return { status: postgres === 'up' && sqs === 'up' ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }
}
