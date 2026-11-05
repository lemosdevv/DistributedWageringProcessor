import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_HEADER = 'x-correlation-id';
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface CorrelatedRequest extends Request {
  correlationId: string;
}

/** Propaga o correlationId do cliente (se válido) ou gera um novo; devolvido no header da resposta. */
export class CorrelationIdMiddleware {
  use = (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header(CORRELATION_HEADER);
    const correlationId = incoming && VALID_CORRELATION_ID.test(incoming) ? incoming : Bun.randomUUIDv7();
    (req as CorrelatedRequest).correlationId = correlationId;
    res.setHeader(CORRELATION_HEADER, correlationId);
    next();
  };
}

export function correlationIdOf(req: Request): string {
  return (req as Partial<CorrelatedRequest>).correlationId ?? Bun.randomUUIDv7();
}
