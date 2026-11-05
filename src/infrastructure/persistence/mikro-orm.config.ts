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
      // Migrations são escritas à mão: o snapshot de schema do gerador não é usado
      snapshot: false,
      allOrNothing: true,
    },
    debug: false,
  });
}
