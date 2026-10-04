import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { NotFoundError } from '../src/errors/index.js';

describe('Fastify Application Composition & HTTP Lifecycle', () => {
  let app: FastifyInstance;

  const testConfig = parseConfig({
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
    ACCESS_TOKEN_SECRET: 'test-secret-at-least-16-chars',
    SERVICE_NAME: 'test-api',
    LOG_PRETTY: 'false',
    REDACT_KEYS: 'password,token',
  });

  beforeAll(async () => {
    app = await buildApp({ config: testConfig, skipMigrations: true });

    // Register a couple test routes to test error handlers
    app.get('/test-not-found', async () => {
      throw new NotFoundError('Simulated entity not found');
    });

    app.get('/test-unexpected-error', async () => {
      throw new Error('Secret internal database connection string error');
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves /live endpoint with status ok', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/live',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('test-api');
  });

  it('serves /health endpoint with database and redis component reports', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.components.database).toBeDefined();
    expect(body.components.redis).toBeDefined();
  });

  it('generates x-request-id and x-correlation-id when none provided', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/live',
    });

    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-correlation-id']).toBeDefined();
  });

  it('preserves inbound x-correlation-id in response header', async () => {
    const clientCorrelationId = 'client-provided-trace-id-123';
    const res = await app.inject({
      method: 'GET',
      url: '/live',
      headers: {
        'x-correlation-id': clientCorrelationId,
      },
    });

    expect(res.headers['x-correlation-id']).toBe(clientCorrelationId);
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('formats AppError deterministically without leaking internals', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/test-not-found',
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(body.error.message).toBe('Simulated entity not found');
    expect(body.error.statusCode).toBe(404);
    expect(body.error.correlationId).toBeDefined();
    expect(body.error.requestId).toBeDefined();
  });

  it('sanitizes unexpected internal errors to protect sensitive details', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/test-unexpected-error',
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(body.error.message).toBe('An unexpected internal error occurred.');
    // Must NOT leak "Secret internal database connection string"
    expect(JSON.stringify(body)).not.toContain('Secret internal database');
  });
});
