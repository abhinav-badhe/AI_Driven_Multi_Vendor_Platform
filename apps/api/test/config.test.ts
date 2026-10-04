import { describe, it, expect } from 'vitest';
import { parseConfig, ConfigurationError } from '../src/config/index.js';

describe('Configuration Validation', () => {
  const validEnv: Record<string, string> = {
    NODE_ENV: 'test',
    PORT: '4000',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'info',
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
    ACCESS_TOKEN_SECRET: 'super-secret-key-at-least-16-chars',
    SERVICE_NAME: 'test-commerce-api',
    LOG_PRETTY: 'false',
    REDACT_KEYS: 'password,token,secret',
  };

  it('successfully parses valid environment variables into typed categories', () => {
    const config = parseConfig(validEnv);

    expect(config.app.nodeEnv).toBe('test');
    expect(config.app.port).toBe(4000);
    expect(config.app.host).toBe('127.0.0.1');

    expect(config.postgres.host).toBe('localhost');
    expect(config.postgres.port).toBe(5432);
    expect(config.postgres.database).toBe('test_db');

    expect(config.redis.host).toBe('localhost');
    expect(config.redis.port).toBe(6379);
    expect(config.redis.tls).toBe(false);

    expect(config.observability.serviceName).toBe('test-commerce-api');
    expect(config.observability.redactKeys).toContain('password');
  });

  it('fails fast when required configuration is missing', () => {
    const incompleteEnv = { ...validEnv };
    delete (incompleteEnv as Record<string, unknown>).DATABASE_NAME;
    delete (incompleteEnv as Record<string, unknown>).PORT;

    expect(() => parseConfig(incompleteEnv)).toThrowError(ConfigurationError);
  });

  it('fails when enum values are invalid', () => {
    const invalidEnv = { ...validEnv, NODE_ENV: 'invalid_env' };
    expect(() => parseConfig(invalidEnv)).toThrowError(ConfigurationError);
  });
});
