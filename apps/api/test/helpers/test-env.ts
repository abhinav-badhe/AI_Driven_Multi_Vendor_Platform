import type { ParsedEnvForTest } from './types.js';

export const TEST_ENV: ParsedEnvForTest = {
  NODE_ENV: 'test',
  PORT: '0',
  HOST: '127.0.0.1',
  LOG_LEVEL: 'fatal',
  DATABASE_HOST: 'localhost',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'test_db',
  DATABASE_USER: 'test_user',
  DATABASE_PASSWORD: 'test_password',
  DATABASE_POOL_MIN: '1',
  DATABASE_POOL_MAX: '5',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  REDIS_PASSWORD: '',
  REDIS_TLS: 'false',
  ACCESS_TOKEN_SECRET: 'test-secret-key-min-16chars',
  SERVICE_NAME: 'test-api',
  LOG_PRETTY: 'false',
  REDACT_KEYS: 'password,token,secret',
};
