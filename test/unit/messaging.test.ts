import { describe, expect, test } from 'bun:test';
import { WalletBalanceChanged } from '../../src/domain/events/wallet-balance-changed';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { exponentialDelayMs } from '../../src/domain/shared/backoff';
import { brl, NOW, openWallet } from './fixtures';

const later = (ms: number) => new Date(NOW.getTime() + ms);

function sampleOutbox(): OutboxMessage {
  const wallet = openWallet('10.00');
  const entry = wallet.credit({ money: brl('1.00'), transactionId: 't', ledgerEntryId: 'e', at: NOW });
  return OutboxMessage.enqueue(
    WalletBalanceChanged.from(wallet, entry, { eventId: 'evt-9', correlationId: 'c', occurredAt: NOW }),
  );
}

describe('InboxMessage', () => {
  test('is received unprocessed and marks processed once', () => {
    const inbox = InboxMessage.receive({ messageId: 'm', consumerName: 'wager-consumer', payloadHash: 'h', receivedAt: NOW });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(later(1));
    inbox.markProcessed(later(2));
    expect(inbox.processedAt).toEqual(later(1));
  });
});

describe('OutboxMessage', () => {
  test('enqueue uses the event envelope as a plain JSON payload and is due immediately', () => {
    const outbox = sampleOutbox();
    expect(outbox.id).toBe('evt-9');
    expect(outbox.eventType).toBe('WalletBalanceChanged');
    expect(outbox.payload['eventId']).toBe('evt-9');
    expect(outbox.attempts).toBe(0);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(NOW)).toBe(true);
  });

  test('scheduleRetry grows the delay exponentially up to the cap', () => {
    const outbox = sampleOutbox();
    const policy = { baseMs: 1_000, capMs: 5_000 };
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      outbox.scheduleRetry(NOW, policy);
      delays.push(outbox.nextAttemptAt!.getTime() - NOW.getTime());
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
    expect(outbox.attempts).toBe(5);
    expect(outbox.isDue(later(4_999))).toBe(false);
    expect(outbox.isDue(later(5_000))).toBe(true);
  });

  test('a published message is no longer pending nor due', () => {
    const outbox = sampleOutbox();
    outbox.markPublished(later(10));
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(later(1_000_000))).toBe(false);
    expect(outbox.publishedAt).toEqual(later(10));
  });

  test('exponentialDelayMs', () => {
    const policy = { baseMs: 2_000, capMs: 300_000 };
    expect([1, 2, 3, 8, 9, 10].map((attempt) => exponentialDelayMs(attempt, policy))).toEqual([
      2_000, 4_000, 8_000, 256_000, 300_000, 300_000,
    ]);
  });
});
