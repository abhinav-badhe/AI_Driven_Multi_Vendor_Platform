export interface ParsedEnvForTest {
  NODE_ENV: string;
  PORT: string;
  HOST: string;
  LOG_LEVEL: string;
  DATABASE_HOST: string;
  DATABASE_PORT: string;
  DATABASE_NAME: string;
  DATABASE_USER: string;
  DATABASE_PASSWORD: string;
  DATABASE_POOL_MIN: string;
  DATABASE_POOL_MAX: string;
  REDIS_HOST: string;
  REDIS_PORT: string;
  REDIS_PASSWORD: string;
  REDIS_TLS: string;
  ACCESS_TOKEN_SECRET: string;
  SERVICE_NAME: string;
  LOG_PRETTY: string;
  REDACT_KEYS: string;
}
