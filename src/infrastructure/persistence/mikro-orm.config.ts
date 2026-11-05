import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { migrationsList } from './migrations';

export function createMikroOrmConfig(databaseUrl: string) {
  return defineConfig({
    clientUrl: databaseUrl,
    // Entidades são registradas via EntitySchema (ADR-0001); preenchido nas próximas tarefas
    entities: [],
    discovery: { warnWhenNoEntities: false },
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
