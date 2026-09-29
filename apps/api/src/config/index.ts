import dotenv from 'dotenv';
import { RawEnvSchema, type AppConfig } from './schema.js';

dotenv.config();

export class ConfigurationError extends Error {
  public readonly issues: Array<{ field: string; message: string }>;

  constructor(message: string, issues: Array<{ field: string; message: string }>) {
    super(message);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

export function parseConfig(envSource: Record<string, string | undefined>): AppConfig {
  const result = RawEnvSchema.safeParse(envSource);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    const missingKeys = issues.map((i) => `  - ${i.field}: ${i.message}`).join('\n');
    throw new ConfigurationError(
      `Invalid or missing environment configuration:\n${missingKeys}`,
      issues,
    );
  }

  const raw = result.data;

  return {
    app: {
      nodeEnv: raw.NODE_ENV,
      port: raw.PORT,
      host: raw.HOST,
      logLevel: raw.LOG_LEVEL,
    },
    postgres: {
      host: raw.DATABASE_HOST,
      port: raw.DATABASE_PORT,
      database: raw.DATABASE_NAME,
      user: raw.DATABASE_USER,
      password: raw.DATABASE_PASSWORD,
      poolMin: raw.DATABASE_POOL_MIN,
      poolMax: raw.DATABASE_POOL_MAX,
    },
    redis: {
      host: raw.REDIS_HOST,
      port: raw.REDIS_PORT,
      password: raw.REDIS_PASSWORD || undefined,
      tls: raw.REDIS_TLS,
    },
    observability: {
      serviceName: raw.SERVICE_NAME,
      logPretty: raw.LOG_PRETTY,
      redactKeys: raw.REDACT_KEYS,
    },
  };
}

let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = parseConfig(process.env);
  }
  return cachedConfig;
}

export * from './schema.js';
