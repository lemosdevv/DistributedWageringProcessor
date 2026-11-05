import { z } from 'zod';

const booleanFlag = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const appConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  // Defaults apontam para o docker-compose local, para testes e dev rodarem sem .env
  DATABASE_URL: z.string().url().default('postgres://wagering:wagering@localhost:5433/wagering'),
  SQS_ENDPOINT: z.string().url().optional().default('http://localhost:4566'),
  AWS_REGION: z.string().default('us-east-1'),
  WAGER_TRANSACTIONS_QUEUE: z.string().default('wager-transactions.fifo'),
  WAGER_TRANSACTIONS_DLQ: z.string().default('wager-transactions-dlq.fifo'),
  WALLET_EVENTS_QUEUE: z.string().default('wallet-events.fifo'),
  ENABLE_HTTP: booleanFlag,
  ENABLE_SQS_CONSUMER: booleanFlag,
  ENABLE_OUTBOX_PUBLISHER: booleanFlag,
  ENABLE_PENDING_REFERENCE_WORKER: booleanFlag,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadAppConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return appConfigSchema.parse(env);
}
