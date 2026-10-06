import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase, markAllUsersVerified, registerVerifiedUser } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

describe('Phase 5: Checkout Concurrency & Overselling Prevention', () => {
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
    app = await buildApp({
      config,
      dbConnection: db,
      skipMigrations: true,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (db) await db.close();
  });

  it('guarantees that 2 concurrent checkout reservations of 7 units against 10 stock results in exactly 1 success and 0 overselling', async () => {
    // 1. Admin setup
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'admin@concurrency.com',
        password: 'Password123!',
        tenantName: 'Admin Ops',
        role: 'MERCHANT',
      },
    });
    const userRes = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'admin@concurrency.com'`,
    );
    await db.query(`UPDATE tenant_memberships SET role = 'ADMINISTRATOR' WHERE user_id = $1`, [
      userRes.rows[0]!.id,
    ]);
    await markAllUsersVerified(db);
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@concurrency.com', password: 'Password123!' },
    });
    const { accessToken: adminToken } = adminLogin.json();

    // 2. Merchant setup
    const merchantToken = await registerVerifiedUser(app, db, {
      email: 'merchant@concurrency.com',
      password: 'Password123!',
      tenantName: 'Concurrency Merchant',
      role: 'MERCHANT',
    });

    await app.inject({
      method: 'POST',
      url: '/merchants/onboard',
      headers: { authorization: `Bearer ${merchantToken}` },
      payload: { businessName: 'Flash Corp', legalName: 'Flash Corp Legal', contactEmail: 'flash@corp.com' },
    });
    await app.inject({ method: 'POST', url: '/merchants/me/submit', headers: { authorization: `Bearer ${merchantToken}` } });
    const prof = (await app.inject({ method: 'GET', url: '/merchants/me', headers: { authorization: `Bearer ${merchantToken}` } })).json();
    await app.inject({ method: 'POST', url: `/merchants/${prof.tenantId}/approve`, headers: { authorization: `Bearer ${adminToken}` } });

    // 3. Catalog setup: Category, Product, SKU
    const cat = (
      await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Hardware', slug: 'hardware' },
      })
    ).json();

    const prod = (
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'Limited Edition Device', slug: 'limited-device', categoryId: cat.id },
      })
    ).json();
    await app.inject({ method: 'POST', url: `/products/${prod.id}/status`, headers: { authorization: `Bearer ${adminToken}` }, payload: { status: 'ACTIVE' } });

    const sku = (
      await app.inject({
        method: 'POST',
        url: `/products/${prod.id}/skus`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { skuCode: 'LTD-DEV-01' },
      })
    ).json();
    await app.inject({ method: 'POST', url: `/skus/${sku.id}/status`, headers: { authorization: `Bearer ${adminToken}` }, payload: { status: 'ACTIVE' } });

    // 4. Listing: ₹10,000
    const listing = (
      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${merchantToken}` },
        payload: { skuId: sku.id, priceAmount: 1000000, currency: 'INR' },
      })
    ).json();
    await app.inject({ method: 'POST', url: `/listings/${listing.id}/status`, headers: { authorization: `Bearer ${merchantToken}` }, payload: { status: 'ACTIVE' } });

    // 5. Inventory: Exactly 10 on-hand units
    const inv = (
      await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${merchantToken}` },
        payload: { listingId: listing.id, initialOnHandQuantity: 10 },
      })
    ).json();

    // 6. Two distinct Customers
    const tokenCust1 = await registerVerifiedUser(app, db, {
      email: 'buyer1@concurrency.com',
      password: 'Password123!',
      tenantName: 'Buyer 1 Tenant',
      role: 'CUSTOMER',
    });

    const tokenCust2 = await registerVerifiedUser(app, db, {
      email: 'buyer2@concurrency.com',
      password: 'Password123!',
      tenantName: 'Buyer 2 Tenant',
      role: 'CUSTOMER',
    });

    // Both customers add 7 units of the same listing to their respective carts
    await app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { authorization: `Bearer ${tokenCust1}` },
      payload: { listingId: listing.id, quantity: 7 },
    });
    await app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { authorization: `Bearer ${tokenCust2}` },
      payload: { listingId: listing.id, quantity: 7 },
    });

    // Both customers create checkout sessions (validation passes because on-hand is 10)
    const session1Res = await app.inject({
      method: 'POST',
      url: '/checkout/sessions',
      headers: { authorization: `Bearer ${tokenCust1}` },
    });
    expect(session1Res.statusCode).toBe(201);
    const session1 = session1Res.json();

    const session2Res = await app.inject({
      method: 'POST',
      url: '/checkout/sessions',
      headers: { authorization: `Bearer ${tokenCust2}` },
    });
    expect(session2Res.statusCode).toBe(201);
    const session2 = session2Res.json();

    // 7. CONCURRENT EXECUTION: Both sessions race to reserve 7 units simultaneously
    const [reserve1, reserve2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session1.id}/reserve`,
        headers: { authorization: `Bearer ${tokenCust1}` },
      }),
      app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session2.id}/reserve`,
        headers: { authorization: `Bearer ${tokenCust2}` },
      }),
    ]);

    const statusCodes = [reserve1.statusCode, reserve2.statusCode];
    expect(statusCodes).toContain(200);
    expect(statusCodes).toContain(409);

    // 8. Verify Authoritative Inventory Truth in Inventory Context
    const invRes = await app.inject({
      method: 'GET',
      url: `/inventory/${inv.id}`,
      headers: { authorization: `Bearer ${merchantToken}` },
    });
    const invState = invRes.json();

    // Critical Invariant: Reserved Quantity must be EXACTLY 7. Available must be 3.
    expect(invState.onHandQuantity).toBe(10);
    expect(invState.reservedQuantity).toBe(7);
    expect(invState.availableQuantity).toBe(3);
    expect(invState.reservedQuantity).toBeLessThanOrEqual(invState.onHandQuantity);
  });
});
