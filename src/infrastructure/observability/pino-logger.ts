import pino, { type Logger } from 'pino';
import type { LogContext, StructuredLogger } from '../../application/ports/observability';

const REDACTED_PATHS = [
  'money',
  'balance',
  'payload',
  'data',
  'body',
  'req.body',
  'req.headers.authorization',
  'req.headers["idempotency-key"]',
  '*.money',
  '*.payload',
];

export function createPinoLogger(level: string, destination?: pino.DestinationStream): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: { service: 'distributed-wagering-processor', pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    formatters: { level: (label) => ({ level: label }) },
  };
  return destination ? pino(options, destination) : pino(options);
}

export class PinoStructuredLogger implements StructuredLogger {
  constructor(private readonly logger: Logger) {}

  info(context: LogContext, message: string): void {
    this.logger.info(context, message);
  }

  warn(context: LogContext, message: string): void {
    this.logger.warn(context, message);
  }

  error(context: LogContext, message: string): void {
    this.logger.error(context, message);
  }
}
