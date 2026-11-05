import { z } from 'zod';
import { InvalidPayloadError } from './errors';

/*
 * Contratos de entrada compartilhados pela API HTTP e pela fila (§9, §10).
 * `amount` precisa ser string: um número JSON já perdeu precisão antes de chegar aqui.
 * Regras de formato do valor (escala, sinal, notação) ficam no Money.
 */
export const nonEmptyString = z.string().trim().min(1).max(256);

export const moneySchema = z.object({
  amount: z.string(),
  currency: z.string(),
});

export const wagerTransactionSchema = z.object({
  providerId: nonEmptyString,
  externalTransactionId: nonEmptyString,
  playerId: nonEmptyString,
  walletId: z.string().uuid(),
  roundId: nonEmptyString,
  gameId: nonEmptyString,
  kind: nonEmptyString,
  money: moneySchema,
  referenceExternalTransactionId: nonEmptyString.optional(),
});

export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || what}: ${issue.message}`).join('; ');
    throw new InvalidPayloadError(`Invalid ${what}: ${issues}`);
  }
  return result.data;
}
