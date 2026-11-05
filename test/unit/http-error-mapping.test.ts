import { describe, expect, test } from 'bun:test';
import { ConnectionException } from '@mikro-orm/core';
import { IdempotencyConflictError, InvalidPayloadError, WalletNotFoundError } from '../../src/application/errors';
import { ConcurrencyConflictError, DuplicateWriteError } from '../../src/application/ports/wagering-store';
import { WalletAlreadyExistsError } from '../../src/application/wallets/create-wallet.use-case';
import { mapError } from '../../src/interfaces/http/http-exception.filter';

describe('HTTP error mapping', () => {
  test.each([
    ['invalid payload', new InvalidPayloadError('x'), 400, 'INVALID_PAYLOAD'],
    ['idempotency conflict', new IdempotencyConflictError('k'), 409, 'IDEMPOTENCY_CONFLICT'],
    ['duplicate wallet', new WalletAlreadyExistsError('p', 'BRL'), 409, 'WALLET_ALREADY_EXISTS'],
    ['unknown wallet', new WalletNotFoundError('w'), 404, 'WALLET_NOT_FOUND'],
    ['database down', new ConnectionException(new Error('connect ECONNREFUSED')), 503, 'TRANSIENT_FAILURE'],
    ['network error code', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 503, 'TRANSIENT_FAILURE'],
    ['race exhausted retries', new ConcurrencyConflictError('w'), 503, 'TRANSIENT_FAILURE'],
    ['duplicate write exhausted retries', new DuplicateWriteError('c', new Error()), 503, 'TRANSIENT_FAILURE'],
    ['unexpected', new Error('bug'), 500, 'INTERNAL_ERROR'],
  ] as const)('%s → %d %s', (_name, error, status, code) => {
    expect(mapError(error)).toMatchObject({ status, code });
  });
});
