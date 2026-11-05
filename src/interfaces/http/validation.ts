import { z } from 'zod';
import { moneySchema, nonEmptyString } from '../../application/contracts';

export { parseOrThrow, wagerTransactionSchema } from '../../application/contracts';

export const createWalletSchema = z.object({
  playerId: nonEmptyString,
  initialBalance: moneySchema,
});

export const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().optional(),
});

export const uuidSchema = z.string().uuid();
export const idempotencyKeySchema = z.string().trim().min(1).max(256);
