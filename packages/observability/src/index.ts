import pino, { Logger, LoggerOptions } from "pino";

export interface LogContext {
  requestId?: string;
  taskId?: string;
  userId?: string;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    ...options
  });
}

export function childLogger(logger: Logger, context: LogContext): Logger {
  return logger.child(context);
}
