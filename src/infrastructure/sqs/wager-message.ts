import { z } from 'zod';
import { parseOrThrow, wagerTransactionSchema } from '../../application/contracts';
import { InvalidPayloadError } from '../../application/errors';
import type { WagerTransactionCommand } from '../../application/wagering/wager-transaction-command';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

const wagerMessageSchema = z.object({
  messageId: z.string().trim().min(1).max(256),
  type: z.literal(WAGER_MESSAGE_TYPE),
  occurredAt: z.string().datetime(),
  data: wagerTransactionSchema.extend({ idempotencyKey: z.string().trim().min(1).max(256) }),
});

export interface ParsedWagerMessage {
  messageId: string;
  idempotencyKey: string;
  command: WagerTransactionCommand;
}

export function parseWagerMessage(body: string | undefined): ParsedWagerMessage {
  let json: unknown;
  try {
    json = JSON.parse(body ?? '');
  } catch {
    throw new InvalidPayloadError('Message body is not valid JSON');
  }
  const message = parseOrThrow(wagerMessageSchema, json, 'message');
  const { idempotencyKey, ...command } = message.data;
  return { messageId: message.messageId, idempotencyKey, command };
}
