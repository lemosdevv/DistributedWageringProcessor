import type { Subprocess } from 'bun';
import { TEST_DATABASE_URL } from './database';

export interface AppInstance {
  name: string;
  port: number;
  baseUrl: string;
  process: Subprocess;
  /** SIGKILL: morte abrupta, sem shutdown gracioso (simula crash/OOM). */
  kill(): Promise<void>;
  stop(): Promise<void>;
}

export interface InstanceQueues {
  wagerQueue: string;
  wagerDlq: string;
  eventsQueue: string;
}

const queueName = (url: string) => url.slice(url.lastIndexOf('/') + 1);

export async function spawnInstance(
  name: string,
  port: number,
  queues: InstanceQueues,
  options: { databaseUrl?: string; env?: Record<string, string> } = {},
): Promise<AppInstance> {
  const child = Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: options.databaseUrl ?? TEST_DATABASE_URL,
      WAGER_TRANSACTIONS_QUEUE: queueName(queues.wagerQueue),
      WAGER_TRANSACTIONS_DLQ: queueName(queues.wagerDlq),
      WALLET_EVENTS_QUEUE: queueName(queues.eventsQueue),
      SQS_WAIT_TIME_SECONDS: '1',
      SQS_RETRY_BASE_SECONDS: '1',
      SQS_RETRY_MAX_SECONDS: '2',
      LOG_LEVEL: 'warn',
      ...options.env,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.status === 200) break;
    } catch {
    }
    if (child.exitCode !== null) throw new Error(`instance ${name} exited with ${child.exitCode}`);
    await Bun.sleep(200);
  }

  return {
    name,
    port,
    baseUrl,
    process: child,
    kill: async () => {
      child.kill('SIGKILL');
      await child.exited;
    },
    stop: async () => {
      child.kill('SIGTERM');
      await Promise.race([child.exited, Bun.sleep(15_000).then(() => child.kill('SIGKILL'))]);
    },
  };
}

/** Espera uma condição assíncrona virar verdadeira (ou falha com a última leitura). */
export async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!done(last)) {
    if (Date.now() > deadline) {
      throw new Error(`condition not reached in ${timeoutMs}ms; last value: ${JSON.stringify(last)}`);
    }
    await Bun.sleep(300);
    last = await read();
  }
  return last;
}
