import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase, registerVerifiedUser } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

describe('Price-drop alerts (views, drops, email queue)', () => {
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

  async function seedCatalog() {
    await db.query(
      `INSERT INTO tenants (id, type, name, status) VALUES ('tenant-m1', 'MERCHANT', 'M One', 'ACTIVE')`,
    );
    await db.query(
      `INSERT INTO categories (id, name, slug) VALUES ('cat-g', 'Groceries', 'groceries')`,
    );
    await db.query(
      `INSERT INTO products (id, title, slug, brand, category_id, status, thumbnail_url, rating, review_count)
       VALUES ('prod-apple', 'Apple', 'apple', NULL, 'cat-g', 'ACTIVE', 'http://img/apple.webp', 4.2, 3)`,
    );
    await db.query(
      `INSERT INTO product_skus (id, product_id, sku_code, status)
       VALUES ('sku-apple', 'prod-apple', 'GRO-APP-001', 'ACTIVE')`,
    );
    await db.query(
      `INSERT INTO merchant_listings (id, tenant_id, sku_id, price_amount, currency, status)
       VALUES ('list-apple', 'tenant-m1', 'sku-apple', 10000, 'USD', 'ACTIVE')`,
    );
    await db.query(
      `INSERT INTO inventory_items (id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity, version)
       VALUES ('inv-apple', 'tenant-m1', 'list-apple', 'sku-apple', 50, 0, 0, 1)`,
    );
  }

  async function merchantToken() {
    return registerVerifiedUser(app, db, {
      email: 'seller@price.test',
      password: 'Password123!',
      tenantName: 'Price Seller',
      role: 'MERCHANT',
    });
  }

  async function customerToken() {
    return registerVerifiedUser(app, db, {
      email: 'buyer@price.test',
      password: 'Password123!',
      tenantName: 'Price Buyer',
      role: 'CUSTOMER',
    });
  }

  async function alertRows() {
    const res = await db.query<{ recipient: string; notification_type: string }>(
      `SELECT recipient, notification_type FROM notifications WHERE notification_type = 'PRICE_DROP_ALERT'`,
    );
    return res.rows;
  }

  it('admin sweep catches drops missed by the inline check', async () => {
    await seedCatalog();
    const cust = await customerToken();

    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'sweep-admin@price.test',
        password: 'Password123!',
        tenantName: 'Sweep Ops',
        role: 'MERCHANT',
      },
    });
    const adminUser = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'sweep-admin@price.test'`,
    );
    await db.query(`UPDATE tenant_memberships SET role = 'ADMINISTRATOR' WHERE user_id = $1`, [
      adminUser.rows[0]!.id,
    ]);
    await db.query(`UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE id = $1`, [
      adminUser.rows[0]!.id,
    ]);
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'sweep-admin@price.test', password: 'Password123!' },
    });
    const adminToken = adminLogin.json().accessToken as string;

    await app.inject({
      method: 'POST',
      url: '/products/prod-apple/views',
      headers: { authorization: `Bearer ${cust}` },
      payload: { priceSeenMinor: 10000, currency: 'USD' },
    });

    // Price falls silently (direct DB change, no listing PATCH).
    await db.query(`UPDATE merchant_listings SET price_amount = 7000 WHERE id = 'list-apple'`);

    const sweep = await app.inject({
      method: 'POST',
      url: '/price-alerts/sweep',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(sweep.statusCode).toBe(200);
    expect(sweep.json().productsChecked).toBe(1);
    expect(sweep.json().alertsSent).toBe(1);

    const rows = await alertRows();
    expect(rows).toHaveLength(1);

    // Non-admins cannot run the sweep.
    const forbidden = await app.inject({
      method: 'POST',
      url: '/price-alerts/sweep',
      headers: { authorization: `Bearer ${cust}` },
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('alerts through the merchant-owned listing path and dedupes repeats', async () => {
    await seedCatalog();
    await merchantToken();
    const cust = await customerToken();
    // Move the seeded listing under the test merchant's tenant.
    const merchTenant = await db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenant_memberships WHERE user_id = (SELECT id FROM users WHERE email = 'seller@price.test')`,
    );
    const merchTenantId = merchTenant.rows[0]!.tenant_id;
    await db.query(`UPDATE merchant_listings SET tenant_id = $1 WHERE id = 'list-apple'`, [merchTenantId]);
    await db.query(`UPDATE inventory_items SET tenant_id = $1 WHERE id = 'inv-apple'`, [merchTenantId]);
    const merch = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'seller@price.test', password: 'Password123!' },
    }).then((r) => r.json().accessToken as string);

    await app.inject({
      method: 'POST',
      url: '/products/prod-apple/views',
      headers: { authorization: `Bearer ${cust}` },
      payload: { priceSeenMinor: 10000, currency: 'USD' },
    });

    const dropRes = await app.inject({
      method: 'PATCH',
      url: '/listings/list-apple',
      headers: { authorization: `Bearer ${merch}` },
      payload: { priceAmount: 8000 },
    });
    expect(dropRes.statusCode).toBe(200);

    let rows = await alertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipient).toBe('buyer@price.test');

    const body = await db.query<{ payload: unknown }>(
      `SELECT payload FROM notifications WHERE notification_type = 'PRICE_DROP_ALERT'`,
    );
    expect(JSON.stringify(body.rows[0]!.payload)).toContain('Apple');

    // Same price again → no duplicate alert.
    await app.inject({
      method: 'PATCH',
      url: '/listings/list-apple',
      headers: { authorization: `Bearer ${merch}` },
      payload: { priceAmount: 8000 },
    });
    rows = await alertRows();
    expect(rows).toHaveLength(1);

    // Deeper drop → second alert.
    await app.inject({
      method: 'PATCH',
      url: '/listings/list-apple',
      headers: { authorization: `Bearer ${merch}` },
      payload: { priceAmount: 6000 },
    });
    rows = await alertRows();
    expect(rows).toHaveLength(2);
  });

  it('does not alert viewers who saw an equal-or-lower price', async () => {
    await seedCatalog();
    const cust = await customerToken();

    await app.inject({
      method: 'POST',
      url: '/products/prod-apple/views',
      headers: { authorization: `Bearer ${cust}` },
      payload: { priceSeenMinor: 5000, currency: 'USD' },
    });

    // Price is still above what this viewer saw — sweep must stay silent.
    const adminToken = await adminTokenForSweep();
    const sweep = await app.inject({
      method: 'POST',
      url: '/price-alerts/sweep',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(sweep.statusCode).toBe(200);
    expect(sweep.json().alertsSent).toBe(0);

    const rows = await alertRows();
    expect(rows).toHaveLength(0);
  });

  async function adminTokenForSweep(): Promise<string> {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'sweep-admin2@price.test',
        password: 'Password123!',
        tenantName: 'Sweep Ops 2',
        role: 'MERCHANT',
      },
    });
    const adminUser = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'sweep-admin2@price.test'`,
    );
    await db.query(`UPDATE tenant_memberships SET role = 'ADMINISTRATOR' WHERE user_id = $1`, [
      adminUser.rows[0]!.id,
    ]);
    await db.query(`UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE id = $1`, [
      adminUser.rows[0]!.id,
    ]);
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'sweep-admin2@price.test', password: 'Password123!' },
    });
    return adminLogin.json().accessToken as string;
  }

  it('rejects views from non-customers and unknown products', async () => {
    await seedCatalog();
    const merch = await merchantToken();

    const forbidden = await app.inject({
      method: 'POST',
      url: '/products/prod-apple/views',
      headers: { authorization: `Bearer ${merch}` },
      payload: { priceSeenMinor: 10000, currency: 'USD' },
    });
    expect(forbidden.statusCode).toBe(403);

    const cust = await customerToken();
    const missing = await app.inject({
      method: 'POST',
      url: '/products/no-such-product/views',
      headers: { authorization: `Bearer ${cust}` },
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
  });

  it('lets customers unsubscribe from alerts', async () => {
    await seedCatalog();
    const cust = await customerToken();

    await app.inject({
      method: 'POST',
      url: '/products/prod-apple/views',
      headers: { authorization: `Bearer ${cust}` },
      payload: { priceSeenMinor: 10000, currency: 'USD' },
    });

    const unsub = await app.inject({
      method: 'DELETE',
      url: '/price-alerts/watches/prod-apple',
      headers: { authorization: `Bearer ${cust}` },
    });
    expect(unsub.statusCode).toBe(200);

    const mine = await app.inject({
      method: 'GET',
      url: '/price-alerts/mine',
      headers: { authorization: `Bearer ${cust}` },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()[0].unsubscribed).toBe(true);
  });
});
