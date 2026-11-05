import { describe, expect, test } from 'bun:test';
import { createPinoLogger, PinoStructuredLogger } from '../../src/infrastructure/observability/pino-logger';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = { write: (chunk: string) => lines.push(JSON.parse(chunk)) };
  return { lines, logger: new PinoStructuredLogger(createPinoLogger('info', destination)) };
}

describe('structured logger', () => {
  test('writes JSON with the correlation fields', () => {
    const { lines, logger } = capture();
    logger.info(
      { correlationId: 'c-1', messageId: 'm-1', transactionId: 't-1', walletId: 'w-1', providerId: 'p-1' },
      'wager transaction handled',
    );
    expect(lines[0]).toMatchObject({
      level: 'info',
      msg: 'wager transaction handled',
      correlationId: 'c-1',
      messageId: 'm-1',
      transactionId: 't-1',
      walletId: 'w-1',
      providerId: 'p-1',
      service: 'distributed-wagering-processor',
    });
  });

  test('redacts financial payloads if they ever reach a log call', () => {
    const { lines, logger } = capture();
    logger.warn(
      {
        walletId: 'w-1',
        money: { amount: '25.00', currency: 'BRL' },
        payload: { secret: true },
        body: { initialBalance: { amount: '1000.00' } },
      },
      'oops',
    );
    expect(lines[0]).toMatchObject({ walletId: 'w-1', money: '[REDACTED]', payload: '[REDACTED]', body: '[REDACTED]' });
  });
});
