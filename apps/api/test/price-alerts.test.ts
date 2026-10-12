import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase, registerVerifiedUser } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';
import { PriceAlertService, PriceAlertSweepRunner } from '../src/modules/price-alerts/index.js';
import {
  notificationModule,
  type INotificationClient,
  type NotificationStatus,
} from '../src/modules/notifications/index.js';

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
    await db.query(`UPDATE merchant_listings SET tenant_id = $1 WHERE id = 'list-apple'`, [
      merchTenantId,
    ]);
    await db.query(`UPDATE inventory_items SET tenant_id = $1 WHERE id = 'inv-apple'`, [
      merchTenantId,
    ]);
    const merch = await app
      .inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'seller@price.test', password: 'Password123!' },
      })
      .then((r) => r.json().accessToken as string);

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

  describe('Reliability and runner lifecycle improvements', () => {
    it('notification enqueue failure does not permanently lose the alert and recovers on later sweep', async () => {
      await seedCatalog();
      const cust = await customerToken();

      // Customer viewed apple at 10000
      await app.inject({
        method: 'POST',
        url: '/products/prod-apple/views',
        headers: { authorization: `Bearer ${cust}` },
        payload: { priceSeenMinor: 10000, currency: 'USD' },
      });

      // Price drops in catalog to 7500
      await db.query(`UPDATE merchant_listings SET price_amount = 7500 WHERE id = 'list-apple'`);

      // Verify watcher has last_alerted_price = null initially
      const watchBefore = await db.query<{ last_alerted_price: number | null }>(
        `SELECT last_alerted_price FROM product_price_watches WHERE product_id = 'prod-apple'`,
      );
      expect(watchBefore.rows[0]!.last_alerted_price).toBeNull();

      const realNotifService = notificationModule.createService(db, app.log as any);
      const realClient = notificationModule.createClient(realNotifService);

      let failEnqueue = true;
      const flakyClient: INotificationClient = {
        requestNotification: vi.fn(async (input) => {
          if (failEnqueue) {
            throw new Error('Simulated transient database timeout while inserting notification');
          }
          return realClient.requestNotification(input);
        }),
        sendTransactionalEmail: vi.fn(),
        processPendingNotifications: vi.fn(),
      };

      const service = new PriceAlertService(
        db,
        flakyClient,
        app.log as any,
        'http://localhost:3000',
      );

      // Attempt 1: Transient failure during enqueue
      const attempt1 = await service.checkProduct('prod-apple');
      expect(attempt1.checked).toBe(true);
      expect(attempt1.alertsSent).toBe(0);

      // Verify:
      // 1. notifications table has 0 rows (enqueue failed)
      const notifs1 = await db.query(
        `SELECT * FROM notifications WHERE notification_type = 'PRICE_DROP_ALERT'`,
      );
      expect(notifs1.rows).toHaveLength(0);

      // 2. product_price_watches last_alerted_price is STILL NULL (not marked alerted!)
      const watch1 = await db.query<{ last_alerted_price: number | null }>(
        `SELECT last_alerted_price FROM product_price_watches WHERE product_id = 'prod-apple'`,
      );
      expect(watch1.rows[0]!.last_alerted_price).toBeNull();

      // Attempt 2: Later retry (e.g. background sweep runner or subsequent check)
      failEnqueue = false;
      const attempt2 = await service.checkProduct('prod-apple');
      expect(attempt2.checked).toBe(true);
      expect(attempt2.alertsSent).toBe(1);

      // Verify:
      // 1. notifications table now has 1 row
      const notifs2 = await db.query<{ status: string }>(
        `SELECT status FROM notifications WHERE notification_type = 'PRICE_DROP_ALERT'`,
      );
      expect(notifs2.rows).toHaveLength(1);
      expect(notifs2.rows[0]!.status).toBe('PENDING');

      // 2. watch last_alerted_price is still null because notification is only PENDING, not confirmed delivered
      const watch2 = await db.query<{ last_alerted_price: number | null }>(
        `SELECT last_alerted_price FROM product_price_watches WHERE product_id = 'prod-apple'`,
      );
      expect(watch2.rows[0]!.last_alerted_price).toBeNull();
    });

    it('repeated sweeps or duplicate listing updates at same floor price do not create duplicate records or outbound deliveries', async () => {
      await seedCatalog();
      const cust = await customerToken();

      // Customer views apple at 10000
      await app.inject({
        method: 'POST',
        url: '/products/prod-apple/views',
        headers: { authorization: `Bearer ${cust}` },
        payload: { priceSeenMinor: 10000, currency: 'USD' },
      });

      const notifService = notificationModule.createService(db, app.log as any);
      const notifClient = notificationModule.createClient(notifService);
      const service = new PriceAlertService(
        db,
        notifClient,
        app.log as any,
        'http://localhost:3000',
      );

      // Price drops to 8000
      await db.query(`UPDATE merchant_listings SET price_amount = 8000 WHERE id = 'list-apple'`);

      // 1st sweep: queues notification in PENDING state
      const sweep1 = await service.sweepAll();
      expect(sweep1.alertsSent).toBe(1);

      const rows1 = await alertRows();
      expect(rows1).toHaveLength(1);

      // Simulate notification delivery via processPendingNotifications
      const dispatch1 = await notifClient.processPendingNotifications();
      expect(dispatch1.sent).toBe(1);

      // Verify notification in DB is now SENT
      const notifRecord = await db.query<{ status: string }>(
        `SELECT status FROM notifications WHERE notification_type = 'PRICE_DROP_ALERT'`,
      );
      expect(notifRecord.rows[0]!.status).toBe('SENT');

      // 2nd sweep: runs at the SAME floor price (8000)
      // The sweep reconciles the existing SENT notification and marks watcher alerted!
      const sweep2 = await service.sweepAll();
      expect(sweep2.reconciled).toBe(1);
      expect(sweep2.alertsSent).toBe(0);

      // Verify: Still exactly 1 notification record in DB (no duplicates!)
      const rows2 = await alertRows();
      expect(rows2).toHaveLength(1);

      // Verify: Watcher has last_alerted_price updated to 8000
      const watchAfter = await db.query<{ last_alerted_price: number | null; alert_count: number }>(
        `SELECT last_alerted_price, alert_count FROM product_price_watches WHERE product_id = 'prod-apple'`,
      );
      expect(Number(watchAfter.rows[0]!.last_alerted_price)).toBe(8000);
      expect(Number(watchAfter.rows[0]!.alert_count)).toBe(1);

      // 3rd sweep at the same floor price: watcher is no longer an eligible candidate
      const sweep3 = await service.sweepAll();
      expect(sweep3.alertsSent).toBe(0);

      // Repeated dispatch finds nothing to send (no duplicate outbound deliveries)
      const dispatch2 = await notifClient.processPendingNotifications();
      expect(dispatch2.sent).toBe(0);
      expect(dispatch2.claimed).toBe(0);

      // Rows still exactly 1
      const rows3 = await alertRows();
      expect(rows3).toHaveLength(1);
    });

    it('a later lower floor price produces a new alert after previous price was alerted', async () => {
      await seedCatalog();
      const cust = await customerToken();

      await app.inject({
        method: 'POST',
        url: '/products/prod-apple/views',
        headers: { authorization: `Bearer ${cust}` },
        payload: { priceSeenMinor: 10000, currency: 'USD' },
      });

      const notifService = notificationModule.createService(db, app.log as any);
      const notifClient = notificationModule.createClient(notifService);
      const service = new PriceAlertService(
        db,
        notifClient,
        app.log as any,
        'http://localhost:3000',
      );

      // 1st drop to 8000
      await db.query(`UPDATE merchant_listings SET price_amount = 8000 WHERE id = 'list-apple'`);
      await service.checkProduct('prod-apple');
      await notifClient.processPendingNotifications();
      // Reconcile delivery
      await service.sweepAll();

      const notifsAfterFirst = await alertRows();
      expect(notifsAfterFirst).toHaveLength(1);

      const watch1 = await db.query<{ last_alerted_price: number | null }>(
        `SELECT last_alerted_price FROM product_price_watches WHERE product_id = 'prod-apple'`,
      );
      expect(Number(watch1.rows[0]!.last_alerted_price)).toBe(8000);

      // 2nd drop to lower floor: 6000
      await db.query(`UPDATE merchant_listings SET price_amount = 6000 WHERE id = 'list-apple'`);
      const check2 = await service.checkProduct('prod-apple');
      expect(check2.alertsSent).toBe(1);

      const notifsAfterSecond = await alertRows();
      expect(notifsAfterSecond).toHaveLength(2);

      const secondRecord = await db.query<{ event_id: string }>(
        `SELECT event_id FROM notifications WHERE notification_type = 'PRICE_DROP_ALERT' AND event_id LIKE '%6000'`,
      );
      expect(secondRecord.rows).toHaveLength(1);
      expect(secondRecord.rows[0]!.event_id).toBe('price-drop:prod-apple:6000');
    });

    it('correctly handles real notification contract statuses (PENDING, RETRY_SCHEDULED, DEAD_LETTERED, SENT)', async () => {
      await seedCatalog();
      const cust = await customerToken();

      await app.inject({
        method: 'POST',
        url: '/products/prod-apple/views',
        headers: { authorization: `Bearer ${cust}` },
        payload: { priceSeenMinor: 10000, currency: 'USD' },
      });

      await db.query(`UPDATE merchant_listings SET price_amount = 7000 WHERE id = 'list-apple'`);

      let simulatedStatus: NotificationStatus = 'PENDING';
      const mockClient: INotificationClient = {
        requestNotification: vi.fn(async () => ({
          notificationId: 'notif-mock-1',
          status: simulatedStatus,
          channel: 'EMAIL' as const,
          recipient: 'buyer@price.test',
          idempotencyKey: 'key-1',
        })),
        sendTransactionalEmail: vi.fn(),
        processPendingNotifications: vi.fn(),
      };

      const service = new PriceAlertService(
        db,
        mockClient,
        app.log as any,
        'http://localhost:3000',
      );

      // 1. PENDING: queued, but NOT delivered yet -> must NOT mark alerted!
      simulatedStatus = 'PENDING';
      await service.checkProduct('prod-apple');
      let watch = await db.query<{ last_alerted_price: number | null; alert_count: number }>(
        `SELECT last_alerted_price, alert_count FROM product_price_watches WHERE product_id = 'prod-apple'`,
      );
      expect(watch.rows[0]!.last_alerted_price).toBeNull();
      expect(Number(watch.rows[0]!.alert_count)).toBe(0);

      // 2. RETRY_SCHEDULED: delivery failed temporarily and scheduled for retry -> must NOT mark alerted!
      simulatedStatus = 'RETRY_SCHEDULED';
      await service.checkProduct('prod-apple');
      watch = await db.query<{ last_alerted_price: number | null; alert_count: number }>(
        `SELECT last_alerted_price, alert_count FROM product_price_watches WHERE product_id = 'prod-apple'`,
      );
      expect(watch.rows[0]!.last_alerted_price).toBeNull();
      expect(Number(watch.rows[0]!.alert_count)).toBe(0);

      // 3. DEAD_LETTERED: delivery permanently failed -> must NOT mark alerted!
      simulatedStatus = 'DEAD_LETTERED';
      await service.checkProduct('prod-apple');
      watch = await db.query<{ last_alerted_price: number | null; alert_count: number }>(
        `SELECT last_alerted_price, alert_count FROM product_price_watches WHERE product_id = 'prod-apple'`,
      );
      expect(watch.rows[0]!.last_alerted_price).toBeNull();
      expect(Number(watch.rows[0]!.alert_count)).toBe(0);

      // 4. SENT: confirmed delivery -> MUST mark alerted and increment alert_count!
      simulatedStatus = 'SENT';
      await service.checkProduct('prod-apple');
      watch = await db.query<{ last_alerted_price: number | null; alert_count: number }>(
        `SELECT last_alerted_price, alert_count FROM product_price_watches WHERE product_id = 'prod-apple'`,
      );
      expect(Number(watch.rows[0]!.last_alerted_price)).toBe(7000);
      expect(Number(watch.rows[0]!.alert_count)).toBe(1);
    });

    describe('PriceAlertSweepRunner lifecycle, overlap prevention, and shutdown', () => {
      it('is not started in test mode by default, but starts when enableBackgroundWorkers is true and cleans up on shutdown', async () => {
        // In default test app, runner is registered on app but not started
        expect(app.priceAlertSweepRunner).toBeDefined();
        expect(app.priceAlertSweepRunner!.isRunning).toBe(false);

        // When enableBackgroundWorkers is explicitly enabled:
        const workerConfig = parseConfig({
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

        const workerApp = await buildApp({
          config: workerConfig,
          dbConnection: db,
          skipMigrations: true,
          enableBackgroundWorkers: true,
        });
        await workerApp.ready();

        expect(workerApp.priceAlertSweepRunner).toBeDefined();
        expect(workerApp.priceAlertSweepRunner!.isRunning).toBe(true);

        // Shutdown cleanup: app.close() stops runner
        await workerApp.close();
        expect(workerApp.priceAlertSweepRunner!.isRunning).toBe(false);
      });

      it('prevents overlapping sweep cycles within the same process', async () => {
        let sweepResolve: () => void;
        const sweepPromise = new Promise<void>((resolve) => {
          sweepResolve = resolve;
        });

        let sweepCallCount = 0;
        const mockService = {
          sweepAll: vi.fn(async () => {
            sweepCallCount += 1;
            await sweepPromise;
            return { productsChecked: 1, alertsSent: 0 };
          }),
        } as unknown as PriceAlertService;

        const runner = new PriceAlertSweepRunner(mockService, app.log as any, { intervalMs: 1000 });

        // Trigger first cycle (enters in-flight execution)
        const cycle1Promise = runner.runCycle();
        expect(runner.isSweeping).toBe(true);
        expect(sweepCallCount).toBe(1);

        // Trigger second cycle while first is still in progress
        const cycle2Result = await runner.runCycle();
        // Overlap guard must skip tick and return null
        expect(cycle2Result).toBeNull();
        expect(sweepCallCount).toBe(1); // Service was not invoked again!

        // Complete the first cycle
        sweepResolve!();
        const cycle1Result = await cycle1Promise;
        expect(cycle1Result).toEqual({ productsChecked: 1, alertsSent: 0 });
        expect(runner.isSweeping).toBe(false);
      });

      it('handles unexpected sweep errors safely without crashing or leaking overlap lock', async () => {
        const mockService = {
          sweepAll: vi.fn(async () => {
            throw new Error('Database connection terminated');
          }),
        } as unknown as PriceAlertService;

        const runner = new PriceAlertSweepRunner(mockService, app.log as any, { intervalMs: 1000 });

        const result = await runner.runCycle();
        expect(result).toBeNull();
        // Lock must be released
        expect(runner.isSweeping).toBe(false);
      });
    });

    describe('Historical delivery-state reconciliation guarantees', () => {
      it('reconciles watch after product price changes or becomes unavailable', async () => {
        await seedCatalog();
        const cust = await customerToken();

        // Customer views product at 10000
        await app.inject({
          method: 'POST',
          url: '/products/prod-apple/views',
          headers: { authorization: `Bearer ${cust}` },
          payload: { priceSeenMinor: 10000, currency: 'USD' },
        });

        const notifService = notificationModule.createService(db, app.log as any);
        const notifClient = notificationModule.createClient(notifService);
        const service = new PriceAlertService(
          db,
          notifClient,
          app.log as any,
          'http://localhost:3000',
        );

        // 1. Price drops to 8000 -> notification queued in PENDING
        await db.query(`UPDATE merchant_listings SET price_amount = 8000 WHERE id = 'list-apple'`);
        const enqueueRes = await service.checkProduct('prod-apple');
        expect(enqueueRes.alertsSent).toBe(1);

        // Watch is still unreconciled (pending delivery)
        let watch = await db.query<{ last_alerted_price: number | null; alert_count: number }>(
          `SELECT last_alerted_price, alert_count FROM product_price_watches WHERE product_id = 'prod-apple'`,
        );
        expect(watch.rows[0]!.last_alerted_price).toBeNull();
        expect(Number(watch.rows[0]!.alert_count)).toBe(0);

        // 2. Notification processor delivers the email -> status becomes SENT
        const dispatch = await notifClient.processPendingNotifications();
        expect(dispatch.sent).toBe(1);

        // 3. BEFORE the next sweep, the product becomes UNAVAILABLE (inactive listing)
        await db.query(
          `UPDATE merchant_listings SET status = 'INACTIVE', price_amount = 9500 WHERE id = 'list-apple'`,
        );

        // Verify current floor price is now unavailable (null)
        const floorCheck = await service.checkProduct('prod-apple');
        expect(floorCheck.checked).toBe(false); // unavailable product
        expect(floorCheck.alertsSent).toBe(0);

        // 4. Run sweep: reconciliation must recover historical delivery state from persisted notification
        const sweep = await service.sweepAll();
        expect(sweep.reconciled).toBe(1);

        // Watch is now properly reconciled with the 8000 drop!
        watch = await db.query<{ last_alerted_price: number | null; alert_count: number }>(
          `SELECT last_alerted_price, alert_count FROM product_price_watches WHERE product_id = 'prod-apple'`,
        );
        expect(Number(watch.rows[0]!.last_alerted_price)).toBe(8000);
        expect(Number(watch.rows[0]!.alert_count)).toBe(1);

        // Make product available again at 9500: customer should NOT be alerted for 9500 since last_alerted_price is 8000
        await db.query(`UPDATE merchant_listings SET status = 'ACTIVE' WHERE id = 'list-apple'`);
        const recheck = await service.checkProduct('prod-apple');
        expect(recheck.alertsSent).toBe(0);
      });

      it('repeated reconciliation does not increment alert_count more than once for the same alert', async () => {
        await seedCatalog();
        const cust = await customerToken();

        await app.inject({
          method: 'POST',
          url: '/products/prod-apple/views',
          headers: { authorization: `Bearer ${cust}` },
          payload: { priceSeenMinor: 10000, currency: 'USD' },
        });

        const notifService = notificationModule.createService(db, app.log as any);
        const notifClient = notificationModule.createClient(notifService);
        const service = new PriceAlertService(
          db,
          notifClient,
          app.log as any,
          'http://localhost:3000',
        );

        await db.query(`UPDATE merchant_listings SET price_amount = 8000 WHERE id = 'list-apple'`);
        await service.checkProduct('prod-apple');
        await notifClient.processPendingNotifications();

        // 1st reconciliation pass
        const pass1 = await service.reconcileDeliveredAlerts();
        expect(pass1.reconciled).toBe(1);

        let watch = await db.query<{ last_alerted_price: number | null; alert_count: number }>(
          `SELECT last_alerted_price, alert_count FROM product_price_watches WHERE product_id = 'prod-apple'`,
        );
        expect(Number(watch.rows[0]!.last_alerted_price)).toBe(8000);
        expect(Number(watch.rows[0]!.alert_count)).toBe(1);

        // 2nd reconciliation pass
        const pass2 = await service.reconcileDeliveredAlerts();
        expect(pass2.reconciled).toBe(0); // Already reconciled!

        // 3rd pass via full sweep
        const pass3 = await service.sweepAll();
        expect(pass3.reconciled).toBe(0);

        // Verify alert_count is STILL exactly 1
        watch = await db.query<{ last_alerted_price: number | null; alert_count: number }>(
          `SELECT last_alerted_price, alert_count FROM product_price_watches WHERE product_id = 'prod-apple'`,
        );
        expect(Number(watch.rows[0]!.last_alerted_price)).toBe(8000);
        expect(Number(watch.rows[0]!.alert_count)).toBe(1);
      });

      it('dead-lettered notifications do not become falsely marked as delivered or cause unbounded repeated work', async () => {
        await seedCatalog();
        const cust = await customerToken();

        await app.inject({
          method: 'POST',
          url: '/products/prod-apple/views',
          headers: { authorization: `Bearer ${cust}` },
          payload: { priceSeenMinor: 10000, currency: 'USD' },
        });

        const notifService = notificationModule.createService(db, app.log as any);
        const notifClient = notificationModule.createClient(notifService);
        const service = new PriceAlertService(
          db,
          notifClient,
          app.log as any,
          'http://localhost:3000',
        );

        await db.query(`UPDATE merchant_listings SET price_amount = 8000 WHERE id = 'list-apple'`);
        await service.checkProduct('prod-apple');

        // Mark the queued notification DEAD_LETTERED directly in DB
        await db.query(
          `UPDATE notifications SET status = 'DEAD_LETTERED', attempt_count = 3 WHERE notification_type = 'PRICE_DROP_ALERT'`,
        );

        // Run reconciliation: must not mark dead-lettered as delivered
        const rec = await service.reconcileDeliveredAlerts();
        expect(rec.reconciled).toBe(0);

        const watch = await db.query<{ last_alerted_price: number | null; alert_count: number }>(
          `SELECT last_alerted_price, alert_count FROM product_price_watches WHERE product_id = 'prod-apple'`,
        );
        expect(watch.rows[0]!.last_alerted_price).toBeNull();
        expect(Number(watch.rows[0]!.alert_count)).toBe(0);

        // Subsequent sweeps must NOT repeatedly attempt to send alerts or do unbounded work for the dead-lettered price
        const sweep1 = await service.sweepAll();
        expect(sweep1.alertsSent).toBe(0);
        expect(sweep1.reconciled).toBe(0);

        const sweep2 = await service.sweepAll();
        expect(sweep2.alertsSent).toBe(0);
        expect(sweep2.reconciled).toBe(0);

        // notifications table must still contain exactly 1 record
        const notifs = await alertRows();
        expect(notifs).toHaveLength(1);
      });

      it('survives service restart and executes concurrent reconciliation idempotently', async () => {
        await seedCatalog();
        const cust = await customerToken();

        await app.inject({
          method: 'POST',
          url: '/products/prod-apple/views',
          headers: { authorization: `Bearer ${cust}` },
          payload: { priceSeenMinor: 10000, currency: 'USD' },
        });

        const notifService = notificationModule.createService(db, app.log as any);
        const notifClient = notificationModule.createClient(notifService);
        const serviceInstance1 = new PriceAlertService(
          db,
          notifClient,
          app.log as any,
          'http://localhost:3000',
        );

        await db.query(`UPDATE merchant_listings SET price_amount = 8000 WHERE id = 'list-apple'`);
        await serviceInstance1.checkProduct('prod-apple');
        await notifClient.processPendingNotifications();

        // Simulate app restart: instantiate brand new PriceAlertService instances against the shared DB
        const restartedServiceA = new PriceAlertService(
          db,
          notifClient,
          app.log as any,
          'http://localhost:3000',
        );
        const restartedServiceB = new PriceAlertService(
          db,
          notifClient,
          app.log as any,
          'http://localhost:3000',
        );

        // Execute concurrent reconciliation passes
        const [resA, resB] = await Promise.all([
          restartedServiceA.reconcileDeliveredAlerts(),
          restartedServiceB.reconcileDeliveredAlerts(),
        ]);

        // Exactly one concurrent worker updates the row; total reconciled is 1
        expect(resA.reconciled + resB.reconciled).toBe(1);

        const watch = await db.query<{ last_alerted_price: number | null; alert_count: number }>(
          `SELECT last_alerted_price, alert_count FROM product_price_watches WHERE product_id = 'prod-apple'`,
        );
        expect(Number(watch.rows[0]!.last_alerted_price)).toBe(8000);
        expect(Number(watch.rows[0]!.alert_count)).toBe(1);
      });
    });
  });
});
