import { MikroORM } from '@mikro-orm/postgresql';
import { loadAppConfig } from '../../config/app-config';
import { createMikroOrmConfig } from './mikro-orm.config';

// CLI mínima de migrations rodando direto no Bun: `bun run migration:up` / `migration:down`
async function main(): Promise<void> {
  const direction = process.argv[2];
  if (direction !== 'up' && direction !== 'down') {
    throw new Error('Usage: bun run src/infrastructure/persistence/migrate.ts <up|down>');
  }

  const config = loadAppConfig();
  const orm = await MikroORM.init(createMikroOrmConfig(config.DATABASE_URL));
  try {
    const executed = direction === 'up' ? await orm.migrator.up() : await orm.migrator.down();
    console.log(JSON.stringify({ direction, executed: executed.map((m) => m.name) }));
  } finally {
    await orm.close(true);
  }
}

await main();
