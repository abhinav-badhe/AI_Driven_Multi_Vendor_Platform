import { configSchema, type RawConfig } from './schema.js';

export interface NotificationsConfig {
  app: {
    port: number;
    host: string;
    nodeEnv: 'development' | 'production' | 'test';
    logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  };
  database: {
    url?: string | undefined;
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    poolMin: number;
    poolMax: number;
  };
  auth: {
    jwtSecret: string;
    internalServiceKey: string;
  };
  channels: {
    resendApiKey?: string | undefined;
    emailFrom: string;
  };
  processing: {
    batchSize: number;
    baseRetryDelayMs: number;
    maxAttempts: number;
    consumerReceiptStaleTimeoutMs: number;
  };
}

export function parseConfig(env: Record<string, unknown> = process.env): NotificationsConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const formatted = result.error.errors
      .map((err) => `  ${err.path.join('.')}: ${err.message}`)
      .join('\n');
    throw new Error(`Notifications service configuration validation failed:\n${formatted}`);
  }

  const raw: RawConfig = result.data;

  return {
    app: {
      port: raw.PORT,
      host: raw.HOST,
      nodeEnv: raw.NODE_ENV,
      logLevel: raw.LOG_LEVEL,
    },
    database: {
      url: raw.DATABASE_URL,
      host: raw.DATABASE_HOST,
      port: raw.DATABASE_PORT,
      name: raw.DATABASE_NAME,
      user: raw.DATABASE_USER,
      password: raw.DATABASE_PASSWORD,
      poolMin: raw.DATABASE_POOL_MIN,
      poolMax: raw.DATABASE_POOL_MAX,
    },
    auth: {
      jwtSecret: raw.JWT_SECRET,
      internalServiceKey: raw.INTERNAL_SERVICE_KEY,
    },
    channels: {
      resendApiKey: raw.RESEND_API_KEY,
      emailFrom: raw.EMAIL_FROM,
    },
    processing: {
      batchSize: raw.BATCH_SIZE,
      baseRetryDelayMs: raw.BASE_RETRY_DELAY_MS,
      maxAttempts: raw.MAX_ATTEMPTS,
      consumerReceiptStaleTimeoutMs: raw.CONSUMER_RECEIPT_STALE_TIMEOUT_MS,
    },
  };
}

export function loadConfig(env?: Record<string, unknown>): NotificationsConfig {
  return parseConfig(env);
}

