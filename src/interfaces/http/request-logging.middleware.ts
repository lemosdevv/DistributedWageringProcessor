import type { NextFunction, Request, Response } from 'express';
import type { StructuredLogger } from '../../application/ports/observability';
import { correlationIdOf } from './correlation-id.middleware';

/** Uma linha por requisição: rota, status e duração. Nunca corpo nem headers (dados financeiros/chaves). */
export function requestLogging(logger: StructuredLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = performance.now();
    res.on('finish', () => {
      if (req.path.startsWith('/health') || req.path === '/metrics') return;
      logger.info(
        {
          correlationId: correlationIdOf(req),
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        },
        'http request completed',
      );
    });
    next();
  };
}
