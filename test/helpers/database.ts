import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://wagering:wagering@localhost:5433/wagering';
export const TEST_DATABASE_NAME = process.env.TEST_DATABASE_NAME ?? 'wagering_test';
export const TEST_DATABASE_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DATABASE_NAME}`);

/** Banco separado do de desenvolvimento: os testes podem recriar o schema à vontade. */
async function ensureTestDatabase(): Promise<void> {
  const admin = await MikroORM.init(createMikroOrmConfig(ADMIN_URL));
  try {
    const rows = await admin.em.getConnection().execute('select 1 from pg_database where datname = ?', [TEST_DATABASE_NAME]);
    if (rows.length === 0) {
      await admin.em.getConnection().execute(`create database "${TEST_DATABASE_NAME}"`);
    }
  } finally {
    await admin.close(true);
  }
}

export async function createTestOrm(): Promise<MikroORM> {
  await ensureTestDatabase();
  return MikroORM.init(createMikroOrmConfig(TEST_DATABASE_URL));
}

/**
 * Recria o schema do zero passando pelas migrations (down até 0 e up), o que também
 * exercita a reversibilidade. Não dá para limpar com TRUNCATE: o ledger é append-only.
 */
export async function resetDatabase(orm: MikroORM): Promise<void> {
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();
}

export async function sql<T = Record<string, unknown>>(orm: MikroORM, query: string, params: unknown[] = []): Promise<T[]> {
  return (await orm.em.getConnection().execute(query, params)) as T[];
}
