import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadAppConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  const config = loadAppConfig();
  const app = await NestFactory.create(AppModule);
  // Necessário para o SIGTERM disparar onModuleDestroy/beforeApplicationShutdown (§10)
  app.enableShutdownHooks();
  await app.listen(config.PORT);
}

await bootstrap();
