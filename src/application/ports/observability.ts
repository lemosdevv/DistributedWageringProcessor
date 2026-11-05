/** Campos de correlação exigidos nos logs (§12). Nunca payload financeiro completo. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

export interface StructuredLogger {
  info(context: LogContext, message: string): void;
  warn(context: LogContext, message: string): void;
  error(context: LogContext, message: string): void;
}

export const STRUCTURED_LOGGER = Symbol('STRUCTURED_LOGGER');

export const silentLogger: StructuredLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
