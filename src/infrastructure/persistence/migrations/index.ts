import type { MigrationObject } from '@mikro-orm/core';

// Ordem de execução das migrations; cada nova migration é adicionada ao fim
export const migrationsList: MigrationObject[] = [];
