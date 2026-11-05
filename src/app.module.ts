import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { APP_CONFIG, loadAppConfig } from './config/app-config';
import { createMikroOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { HealthController } from './interfaces/http/health.controller';

const appConfig = loadAppConfig();

@Module({
  imports: [MikroOrmModule.forRoot(createMikroOrmConfig(appConfig.DATABASE_URL))],
  controllers: [HealthController],
  providers: [{ provide: APP_CONFIG, useValue: appConfig }],
})
export class AppModule {}
