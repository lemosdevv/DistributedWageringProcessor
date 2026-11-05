import { z } from 'zod';
import { InvalidPayloadError } from '../../application/errors';

/*
 * Validação estrutural dos contratos (§9). `amount` precisa ser string: um número JSON
 * já perdeu precisão antes de chegar aqui. Regras de formato do valor ficam no Money.
 */
const nonEmpty = z.string().trim().min(1).max(256);

export const moneySchema = z.object({
  amount: z.string(),
  currency: z.string(),
});

export const createWalletSchema = z.object({
  playerId: nonEmpty,
  initialBalance: moneySchema,
});

export const wagerTransactionSchema = z.object({
  providerId: nonEmpty,
  externalTransactionId: nonEmpty,
  playerId: nonEmpty,
  walletId: z.string().uuid(),
  roundId: nonEmpty,
  gameId: nonEmpty,
  kind: nonEmpty,
  money: moneySchema,
  referenceExternalTransactionId: nonEmpty.optional(),
});

export const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().optional(),
});

export const uuidSchema = z.string().uuid();
export const idempotencyKeySchema = z.string().trim().min(1).max(256);

export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || what}: ${issue.message}`).join('; ');
    throw new InvalidPayloadError(`Invalid ${what}: ${issues}`);
  }
  return result.data;
}
