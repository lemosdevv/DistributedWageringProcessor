import { ConnectionException, DeadlockException, LockWaitTimeoutException } from '@mikro-orm/core';
import { ConcurrencyConflictError, DuplicateWriteError } from '../../application/ports/wagering-store';

// Códigos de rede/SQLSTATE que indicam indisponibilidade momentânea, não erro do payload
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
]);

const TRANSIENT_AWS_NAMES = new Set([
  'ServiceUnavailable',
  'ThrottlingException',
  'RequestThrottled',
  'TimeoutError',
  'NetworkingError',
  'InternalError',
]);

/**
 * Falha de infraestrutura que pode ter sucesso se repetida (banco ou fila fora do ar,
 * deadlock, corrida que esgotou as tentativas). Base para 503 na API e retry na fila.
 */
export function isTransientInfrastructureError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    if (
      current instanceof ConnectionException ||
      current instanceof DeadlockException ||
      current instanceof LockWaitTimeoutException ||
      current instanceof DuplicateWriteError ||
      current instanceof ConcurrencyConflictError
    ) {
      return true;
    }
    const candidate = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && TRANSIENT_CODES.has(candidate.code)) {
      return true;
    }
    if (typeof candidate.name === 'string' && TRANSIENT_AWS_NAMES.has(candidate.name)) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
