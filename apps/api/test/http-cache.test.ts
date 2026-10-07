import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import {
  createMigratedTestDatabase,
  markAllUsersVerified,
  registerVerifiedUser,
} from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';
import { createRedisService } from '../src/infra/redis/index.js';
import { CacheService, InMemoryCacheClient } from '../src/infra/redis/cache.js';

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

describe('HTTP cache-aside behavior (X-Cache)', () => {
  let app: FastifyInstance;
  let db: DatabaseConnection;

  beforeEach(async () => {
    db = await createMigratedTestDatabase();
    const config = parseConfig({
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
      ACCESS_TOKEN_SECRET: TOKEN_SECRET,
      SERVICE_NAME: 'test-api',
      LOG_PRETTY: 'false',
      REDACT_KEYS: 'password,token',
    });
    const stubRedis = createRedisService(
      {
        host: 'localhost',
        port: 6379,
        password: 'placeholder_redis_password',
        tls: false,
      },
    );
    app = await buildApp({
      config,
      dbConnection: db,
      skipMigrations: true,
      cache: new CacheService(stubRedis, new InMemoryCacheClient()),
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (db) await db.close();
  });

  it('serves MISS then HIT, and invalidates on writes', async () => {
    const adminToken = await registerVerifiedUser(app, db, {
      email: 'cache-admin@test.com',
      password: 'Password123!',
      tenantName: 'Cache Admin',
      role: 'MERCHANT',
    });
    const userRes = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'cache-admin@test.com'`,
    );
    await db.query(`UPDATE tenant_memberships SET role = 'ADMINISTRATOR' WHERE user_id = $1`, [
      userRes.rows[0]!.id,
    ]);
    await markAllUsersVerified(db);

    const first = await app.inject({ method: 'GET', url: '/categories' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-cache']).toBe('MISS');

    const second = await app.inject({ method: 'GET', url: '/categories' });
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.json()).toEqual(first.json());

    const created = await app.inject({
      method: 'POST',
      url: '/categories',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Cached', slug: 'cached' },
    });
    expect(created.statusCode).toBe(201);

    const afterWrite = await app.inject({ method: 'GET', url: '/categories' });
    expect(afterWrite.headers['x-cache']).toBe('MISS');
    expect(
      (afterWrite.json() as Array<{ slug: string }>).some((c) => c.slug === 'cached'),
    ).toBe(true);
  });

  it('isolates privileged SKU views from public cache entries', async () => {
    const adminToken = await registerVerifiedUser(app, db, {
      email: 'cache-admin2@test.com',
      password: 'Password123!',
      tenantName: 'Cache Admin 2',
      role: 'MERCHANT',
    });
    const userRes = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'cache-admin2@test.com'`,
    );
    await db.query(`UPDATE tenant_memberships SET role = 'ADMINISTRATOR' WHERE user_id = $1`, [
      userRes.rows[0]!.id,
    ]);
    await markAllUsersVerified(db);
    const adminHeaders = { authorization: `Bearer ${adminToken}` };

    const cat = (
      await app.inject({
        method: 'POST',
        url: '/categories',
        headers: adminHeaders,
        payload: { name: 'Iso', slug: 'iso' },
      })
    ).json() as { id: string };
    const prod = (
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: adminHeaders,
        payload: { title: 'Iso Product', slug: 'iso-product', categoryId: cat.id },
      })
    ).json() as { id: string };
    await app.inject({
      method: 'POST',
      url: `/products/${prod.id}/skus`,
      headers: adminHeaders,
      payload: { skuCode: 'ISO-1' },
    });

    // Anonymous request populates the public entry (DRAFT SKU filtered out).
    const anonFirst = await app.inject({ method: 'GET', url: `/products/${prod.id}/skus` });
    expect(anonFirst.headers['x-cache']).toBe('MISS');
    expect(anonFirst.json()).toEqual([]);

    // Admin request must NOT serve the public entry.
    const adminView = await app.inject({
      method: 'GET',
      url: `/products/${prod.id}/skus`,
      headers: adminHeaders,
    });
    expect(adminView.headers['x-cache']).toBe('MISS');
    expect((adminView.json() as Array<unknown>).length).toBe(1);
  });
});
