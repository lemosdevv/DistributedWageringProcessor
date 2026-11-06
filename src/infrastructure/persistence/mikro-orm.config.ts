import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { migrationsList } from './migrations';
import { persistenceSchemas } from './records';

export function createMikroOrmConfig(databaseUrl: string) {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: persistenceSchemas,
    extensions: [Migrator],
    migrations: {
      migrationsList,
      transactional: true,
      snapshot: false,
      allOrNothing: true,
    },
    debug: false,
  });
}
