import type { MigrationObject } from '@mikro-orm/core';
import { InitialSchema20261105000001 } from './20261105000001-initial-schema';

export const migrationsList: MigrationObject[] = [
  { name: '20261105000001-initial-schema', class: InitialSchema20261105000001 },
];
