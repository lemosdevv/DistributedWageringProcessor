import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AppConfig } from './config/app-config';
import { CorrelationIdMiddleware } from './interfaces/http/correlation-id.middleware';
import { HttpExceptionFilter } from './interfaces/http/http-exception.filter';
import { requestLogging } from './interfaces/http/request-logging.middleware';
import { STRUCTURED_LOGGER, type StructuredLogger } from './application/ports/observability';
import { WageringModule } from './wagering.module';

/** Monta a aplicação sem escutar porta: usado pelo main e pelos testes. */
export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(WageringModule.register(config), { logger: ['error', 'warn'] });
  const logger = app.get<StructuredLogger>(STRUCTURED_LOGGER);
  app.use(new CorrelationIdMiddleware().use);
  app.use(requestLogging(logger));
  app.useGlobalFilters(new HttpExceptionFilter(logger));
  // Necessário para o SIGTERM disparar onModuleDestroy/beforeApplicationShutdown (§10)
  app.enableShutdownHooks();
  return app;
}
