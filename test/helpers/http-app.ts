import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/app';
import { loadAppConfig, type AppConfig } from '../../src/config/app-config';
import { TEST_DATABASE_URL } from './database';

export interface RunningApp {
  app: INestApplication;
  baseUrl: string;
  close(): Promise<void>;
}

/** Sobe a aplicação real (Nest + Express) numa porta livre, só com o papel HTTP. */
export async function startHttpApp(overrides: Partial<Record<keyof AppConfig, string>> = {}): Promise<RunningApp> {
  const config = loadAppConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    LOG_LEVEL: 'silent',
    ENABLE_SQS_CONSUMER: 'false',
    ENABLE_OUTBOX_PUBLISHER: 'false',
    ENABLE_PENDING_REFERENCE_WORKER: 'false',
    ...overrides,
  });
  const app = await createApp(config);
  await app.listen(0);
  const address = app.getHttpServer().address() as { port: number };
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, close: () => app.close() };
}

export async function call(
  baseUrl: string,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
}
