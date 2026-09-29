import { createRedactor } from './redact.js';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
};

export interface LogContext {
  correlationId?: string;
  requestId?: string;
  module?: string;
  [key: string]: unknown;
}

export interface Logger {
  fatal(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  trace(message: string, context?: LogContext): void;
  child(defaultContext: LogContext): Logger;
}

export interface LoggerOptions {
  serviceName: string;
  level: LogLevel;
  pretty?: boolean;
  redactKeys?: string[];
  sink?: (line: string) => void;
}

export class JsonLogger implements Logger {
  private readonly serviceName: string;
  private readonly minLevelPriority: number;
  private readonly pretty: boolean;
  private readonly redact: (data: unknown) => unknown;
  private readonly baseContext: LogContext;
  private readonly sink: (line: string) => void;

  constructor(options: LoggerOptions, baseContext: LogContext = {}) {
    this.serviceName = options.serviceName;
    this.minLevelPriority = LOG_LEVEL_PRIORITY[options.level] ?? LOG_LEVEL_PRIORITY.info;
    this.pretty = options.pretty ?? false;
    this.redact = createRedactor(options.redactKeys ?? []);
    this.baseContext = baseContext;
    this.sink = options.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (LOG_LEVEL_PRIORITY[level] < this.minLevelPriority) {
      return;
    }

    const mergedContext = { ...this.baseContext, ...context };
    const redactedContext = this.redact(mergedContext) as Record<string, unknown>;

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.serviceName,
      message,
      ...redactedContext,
    };

    if (this.pretty) {
      this.sink(JSON.stringify(logEntry, null, 2));
    } else {
      this.sink(JSON.stringify(logEntry));
    }
  }

  fatal(message: string, context?: LogContext): void {
    this.write('fatal', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.write('error', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.write('warn', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }

  debug(message: string, context?: LogContext): void {
    this.write('debug', message, context);
  }

  trace(message: string, context?: LogContext): void {
    this.write('trace', message, context);
  }

  child(defaultContext: LogContext): Logger {
    return new JsonLogger(
      {
        serviceName: this.serviceName,
        level: Object.keys(LOG_LEVEL_PRIORITY).find(
          (k) => LOG_LEVEL_PRIORITY[k as LogLevel] === this.minLevelPriority,
        ) as LogLevel,
        pretty: this.pretty,
        sink: this.sink,
      },
      { ...this.baseContext, ...defaultContext },
    );
  }
}
