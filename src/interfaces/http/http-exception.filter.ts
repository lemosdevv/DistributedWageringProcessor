import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApplicationError,
  IdempotencyConflictError,
  WagerTransactionNotFoundError,
  WalletNotFoundError,
} from '../../application/errors';
import type { StructuredLogger } from '../../application/ports/observability';
import { WalletAlreadyExistsError } from '../../application/wallets/create-wallet.use-case';
import { FailureCode } from '../../domain/wagering/failure-code';
import { isTransientInfrastructureError } from '../../infrastructure/errors/transient-error';
import { correlationIdOf } from './correlation-id.middleware';

/**
 * Códigos de erro da API fora da taxonomia de transação (FailureCode), para que
 * todo erro HTTP tenha um código estável legível por máquina.
 */
export enum ApiErrorCode {
  WalletAlreadyExists = 'WALLET_ALREADY_EXISTS',
  TransactionNotFound = 'TRANSACTION_NOT_FOUND',
  NotFound = 'NOT_FOUND',
  TransientFailure = 'TRANSIENT_FAILURE',
  InternalError = 'INTERNAL_ERROR',
}

export interface ErrorBody {
  failureCode: FailureCode | ApiErrorCode;
  message: string;
  correlationId: string;
}

interface Mapped {
  status: number;
  code: FailureCode | ApiErrorCode;
  message: string;
}

/**
 * Mapeamento único e consistente para todos os endpoints (§9):
 * 400 payload inválido · 404 inexistente · 409 conflito · 503 falha transitória · 500 inesperado.
 * (422 e 202 são resultados de negócio e saem do controller, não daqui.)
 */
export function mapError(error: unknown): Mapped {
  if (error instanceof IdempotencyConflictError || error instanceof WalletAlreadyExistsError) {
    const code = error instanceof WalletAlreadyExistsError ? ApiErrorCode.WalletAlreadyExists : error.failureCode;
    return { status: 409, code, message: error.message };
  }
  if (error instanceof WalletNotFoundError) {
    return { status: 404, code: error.failureCode, message: error.message };
  }
  if (error instanceof WagerTransactionNotFoundError) {
    return { status: 404, code: ApiErrorCode.TransactionNotFound, message: error.message };
  }
  if (error instanceof ApplicationError) {
    return { status: 400, code: error.failureCode, message: error.message };
  }
  if (isTransientInfrastructureError(error)) {
    return { status: 503, code: ApiErrorCode.TransientFailure, message: 'Temporarily unavailable, retry later' };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    // Ex.: JSON malformado (400) ou rota inexistente (404) detectados pelo próprio Nest/Express
    if (status === 404) return { status, code: ApiErrorCode.NotFound, message: error.message };
    if (status >= 400 && status < 500) return { status: 400, code: FailureCode.InvalidPayload, message: error.message };
  }
  return { status: 500, code: ApiErrorCode.InternalError, message: 'Internal error' };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: StructuredLogger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const correlationId = correlationIdOf(req);
    const mapped = mapError(error);

    if (mapped.status >= 500) {
      this.logger.error(
        { correlationId, err: error instanceof Error ? { name: error.name, message: error.message } : String(error) },
        `request failed with ${mapped.status}`,
      );
    }
    if (mapped.status === 503) {
      res.setHeader('Retry-After', '1');
    }
    const body: ErrorBody = { failureCode: mapped.code, message: mapped.message, correlationId };
    res.status(mapped.status).json(body);
  }
}
