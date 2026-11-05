import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { migrationsList } from './migrations';
import { persistenceSchemas } from './records';

export function createMikroOrmConfig(databaseUrl: string) {
  return defineConfig({
    clientUrl: databaseUrl,
    // Mapeamento via EntitySchema sobre registros de persistência (ADR-0001)
    entities: persistenceSchemas,
    extensions: [Migrator],
    migrations: {
      // Lista explícita: migrations escritas à mão (constraints, triggers) e sem glob de arquivos
      migrationsList,
      transactional: true,
      allOrNothing: true,
    },
    debug: false,
  });
}
