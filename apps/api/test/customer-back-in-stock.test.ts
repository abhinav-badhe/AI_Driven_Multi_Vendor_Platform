import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase, markAllUsersVerified, registerVerifiedUser } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';
import { EventTypes } from '../src/modules/events/index.js';
import {
  NotificationService,
  NotificationRepository,
  InMemoryEmailProvider,
  InMemorySmsProvider,
  InMemoryPushProvider,
} from '../src/modules/notifications/index.js';

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

describe('Customer Back-in-Stock Alerts & Subscriptions', () => {
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

  async function setupEcosystem() {
    // 1. Admin
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'admin@platform.com',
        password: 'Password123!',
        tenantName: 'Admin Ops',
        role: 'MERCHANT',
      },
    });
    const userRes = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'admin@platform.com'`,
    );
    await db.query(`UPDATE tenant_memberships SET role = 'ADMINISTRATOR' WHERE user_id = $1`, [
      userRes.rows[0]!.id,
    ]);
    await markAllUsersVerified(db);
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@platform.com', password: 'Password123!' },
    });
    const { accessToken: adminToken } = adminLogin.json();

    // 2. Merchant Alpha
    const alphaToken = await registerVerifiedUser(app, db, {
      email: 'alpha@store.com',
      password: 'Password123!',
      tenantName: 'Merchant Alpha Store',
      role: 'MERCHANT',
    });
    await app.inject({
      method: 'POST',
      url: '/merchants/onboard',
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { businessName: 'Alpha LLC', legalName: 'Alpha Legal', contactEmail: 'alpha@biz.com' },
    });
    await app.inject({ method: 'POST', url: '/merchants/me/submit', headers: { authorization: `Bearer ${alphaToken}` } });
    const profA = (await app.inject({ method: 'GET', url: '/merchants/me', headers: { authorization: `Bearer ${alphaToken}` } })).json();
    await app.inject({ method: 'POST', url: `/merchants/${profA.tenantId}/approve`, headers: { authorization: `Bearer ${adminToken}` } });

    // 3. Customers
    const customer1Token = await registerVerifiedUser(app, db, {
      email: 'customer1@user.com',
      password: 'Password123!',
      tenantName: 'Customer 1 Tenant',
      role: 'CUSTOMER',
    });

    const customer2Token = await registerVerifiedUser(app, db, {
      email: 'customer2@user.com',
      password: 'Password123!',
      tenantName: 'Customer 2 Tenant',
      role: 'CUSTOMER',
    });

    // 4. Products and SKUs
    const cat = (
      await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Audio', slug: 'audio' },
      })
    ).json();

    const prod1 = (
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          title: 'Wireless Headphones',
          slug: 'wireless-headphones',
          categoryId: cat.id,
          brand: 'SoundWave',
          thumbnailUrl: 'https://images.example.com/headphones.jpg',
        },
      })
    ).json();

    const sku1 = (
      await app.inject({
        method: 'POST',
        url: `/products/${prod1.id}/skus`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { skuCode: 'WH-BLK-01', attributes: { color: 'Black' } },
      })
    ).json();

    const prod2 = (
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          title: 'Smart Speaker',
          slug: 'smart-speaker',
          categoryId: cat.id,
          brand: 'SoundWave',
        },
      })
    ).json();

    const sku2 = (
      await app.inject({
        method: 'POST',
        url: `/products/${prod2.id}/skus`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { skuCode: 'SPK-GRY-01', attributes: { color: 'Gray' } },
      })
    ).json();

    // Activate products and SKUs
    await app.inject({
      method: 'POST',
      url: `/products/${prod1.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });
    await app.inject({
      method: 'POST',
      url: `/skus/${sku1.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });
    await app.inject({
      method: 'POST',
      url: `/products/${prod2.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });
    await app.inject({
      method: 'POST',
      url: `/skus/${sku2.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    // 5. Merchant Listing for prod1 (initially with 0 stock / uninitialized inventory = Out of stock)
    const list1 = (
      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: {
          skuId: sku1.id,
          priceAmount: 8999,
          currency: 'INR',
        },
      })
    ).json();

    await app.inject({
      method: 'POST',
      url: `/listings/${list1.id}/status`,
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { status: 'ACTIVE' },
    });

    return {
      adminToken,
      alphaToken,
      customer1Token,
      customer2Token,
      prod1,
      sku1,
      prod2,
      sku2,
      list1,
      merchantTenantId: profA.tenantId,
    };
  }

  it('1. Authenticated customer can subscribe to an out-of-stock product (201)', async () => {
    const { customer1Token, prod1, sku1 } = await setupEcosystem();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id, skuId: sku1.id },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.productId).toBe(prod1.id);
    expect(body.skuId).toBe(sku1.id);
    expect(body.status).toBe('ACTIVE');
    expect(body.availability.status).toBe('OUT_OF_STOCK');
  });

  it('2. Unauthenticated request is rejected (401)', async () => {
    const { prod1 } = await setupEcosystem();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/back-in-stock',
      payload: { productId: prod1.id },
    });

    expect(res.statusCode).toBe(401);
  });

  it('3. Product existence validation rejects invalid product (404)', async () => {
    const { customer1Token } = await setupEcosystem();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: 'non-existent-prod-id' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('4. SKU validation rejects SKU not belonging to product (400)', async () => {
    const { customer1Token, prod1, sku2 } = await setupEcosystem();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id, skuId: sku2.id },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error?.message || res.json().message).toContain('does not belong to product');
  });

  it('5. Cannot subscribe when product/SKU is already in stock (400)', async () => {
    const { alphaToken, customer1Token, prod1, sku1, list1 } = await setupEcosystem();

    // Initialize inventory with 10 units in stock
    await app.inject({
      method: 'POST',
      url: '/inventory',
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { listingId: list1.id, initialOnHandQuantity: 10 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id, skuId: sku1.id },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error?.message || res.json().message).toContain('currently in stock');
  });

  it('6. Duplicate subscription is idempotent', async () => {
    const { customer1Token, prod1, sku1 } = await setupEcosystem();

    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id, skuId: sku1.id },
    });
    expect(res1.statusCode).toBe(201);
    const subId1 = res1.json().id;

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id, skuId: sku1.id },
    });
    expect(res2.statusCode).toBe(201);
    const subId2 = res2.json().id;

    expect(subId1).toBe(subId2);

    const countRes = await db.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM back_in_stock_subscriptions WHERE product_id = $1',
      [prod1.id],
    );
    expect(Number(countRes.rows[0]?.count)).toBe(1);
  });

  it('7. Customer can list own subscriptions with resolved product information', async () => {
    const { customer1Token, prod1, sku1, prod2 } = await setupEcosystem();

    await app.inject({
      method: 'POST',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id, skuId: sku1.id },
    });

    await app.inject({
      method: 'POST',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod2.id },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer1Token}` },
    });

    expect(res.statusCode).toBe(200);
    const items = res.json();
    expect(items.length).toBe(2);
    expect(items.some((i: any) => i.productId === prod1.id)).toBe(true);
    expect(items.some((i: any) => i.productId === prod2.id)).toBe(true);
  });

  it('8. Customer can cancel own subscription', async () => {
    const { customer1Token, prod1 } = await setupEcosystem();

    await app.inject({
      method: 'POST',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id },
    });

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customer/back-in-stock/${prod1.id}`,
      headers: { authorization: `Bearer ${customer1Token}` },
    });

    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().cancelled).toBe(true);

    const checkRes = await app.inject({
      method: 'GET',
      url: `/api/v1/customer/back-in-stock/check/${prod1.id}`,
      headers: { authorization: `Bearer ${customer1Token}` },
    });
    expect(checkRes.json().isSubscribed).toBe(false);
    expect(checkRes.json().status).toBe('CANCELLED');
  });

  it('9. Customer cannot access another customer subscriptions (cross-customer isolation)', async () => {
    const { customer1Token, customer2Token, prod1 } = await setupEcosystem();

    await app.inject({
      method: 'POST',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id },
    });

    // Customer 2 check must report false
    const checkCust2 = await app.inject({
      method: 'GET',
      url: `/api/v1/customer/back-in-stock/check/${prod1.id}`,
      headers: { authorization: `Bearer ${customer2Token}` },
    });
    expect(checkCust2.json().isSubscribed).toBe(false);

    // Customer 2 list must be empty
    const listCust2 = await app.inject({
      method: 'GET',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer2Token}` },
    });
    expect(listCust2.json().length).toBe(0);

    // Customer 2 cannot cancel Customer 1 subscription
    const cancelCust2 = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customer/back-in-stock/${prod1.id}`,
      headers: { authorization: `Bearer ${customer2Token}` },
    });
    expect(cancelCust2.json().cancelled).toBe(false);

    // Customer 1 subscription remains intact
    const checkCust1 = await app.inject({
      method: 'GET',
      url: `/api/v1/customer/back-in-stock/check/${prod1.id}`,
      headers: { authorization: `Bearer ${customer1Token}` },
    });
    expect(checkCust1.json().isSubscribed).toBe(true);
  });

  it('10. Inventory restock records INVENTORY_STOCK_AVAILABLE in outbox', async () => {
    const { alphaToken, list1 } = await setupEcosystem();

    const initRes = await app.inject({
      method: 'POST',
      url: '/inventory',
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { listingId: list1.id, initialOnHandQuantity: 5 },
    });
    expect(initRes.statusCode).toBe(201);

    const outboxEvents = await db.query<{ event_type: string; payload: any }>(
      `SELECT event_type, payload FROM outbox_events WHERE event_type IN ($1, $2)`,
      [EventTypes.INVENTORY_STOCK_CHANGED, EventTypes.INVENTORY_STOCK_AVAILABLE],
    );

    expect(outboxEvents.rows.some((e) => e.event_type === EventTypes.INVENTORY_STOCK_AVAILABLE)).toBe(true);
    const availableEvent = outboxEvents.rows.find((e) => e.event_type === EventTypes.INVENTORY_STOCK_AVAILABLE);
    expect(availableEvent?.payload.isAvailable).toBe(true);
    expect(availableEvent?.payload.availableQuantity).toBe(5);
  });

  it('11. BackInStock consumer processes restock and updates subscription status to NOTIFIED', async () => {
    const { customer1Token, prod1, sku1 } = await setupEcosystem();

    // Subscribe while out of stock
    const subRes = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id, skuId: sku1.id },
    });
    expect(subRes.statusCode).toBe(201);
    const subId = subRes.json().id;

    // Simulate inventory event consumer execution
    const customerModule = await import('../src/modules/customer/index.js');
    const service = customerModule.customerModule.createBackInStockService(
      db,
      (app as any).log ?? console,
      undefined,
      undefined,
      'http://localhost:3000',
    );

    const result = await service.processBackInStockNotification({
      productId: prod1.id,
      skuId: sku1.id,
      eventId: 'evt-test-available-1',
    });

    expect(result.processedCount).toBe(1);
    expect(result.notifiedCount).toBe(1);

    const updatedSub = await db.query<{ status: string; notified_at: string }>(
      'SELECT status, notified_at FROM back_in_stock_subscriptions WHERE id = $1',
      [subId],
    );
    expect(updatedSub.rows[0]?.status).toBe('NOTIFIED');
    expect(updatedSub.rows[0]?.notified_at).toBeDefined();
  });

  it('12. Cancelled subscription is not notified when product becomes available', async () => {
    const { customer1Token, prod1, sku1 } = await setupEcosystem();

    await app.inject({
      method: 'POST',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id, skuId: sku1.id },
    });

    // Customer cancels subscription
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/customer/back-in-stock/${prod1.id}`,
      headers: { authorization: `Bearer ${customer1Token}` },
    });

    const customerModule = await import('../src/modules/customer/index.js');
    const service = customerModule.customerModule.createBackInStockService(
      db,
      (app as any).log ?? console,
      undefined,
      undefined,
    );

    const result = await service.processBackInStockNotification({
      productId: prod1.id,
      skuId: sku1.id,
      eventId: 'evt-test-available-2',
    });

    expect(result.notifiedCount).toBe(0);
  });

  it('13. Failed notification delivery does NOT mark subscription as NOTIFIED', async () => {
    const { customer1Token, prod1, sku1 } = await setupEcosystem();

    const subRes = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id, skuId: sku1.id },
    });
    const subId = subRes.json().id;

    // Create a mock notification service that throws an error during dispatch
    const failingNotificationService = {
      requestNotification: vi.fn().mockRejectedValue(new Error('SMTP connection timed out')),
      processPendingNotifications: vi.fn(),
    } as any;

    const customerModule = await import('../src/modules/customer/index.js');
    const service = customerModule.customerModule.createBackInStockService(
      db,
      (app as any).log ?? console,
      failingNotificationService,
      undefined,
    );

    await expect(
      service.processBackInStockNotification({
        productId: prod1.id,
        skuId: sku1.id,
        eventId: 'evt-test-failing-1',
      }),
    ).rejects.toThrow('SMTP connection timed out');

    // Subscription MUST still be ACTIVE (not NOTIFIED) so it can be retried!
    const subRow = await db.query<{ status: string; notified_at: string | null }>(
      'SELECT status, notified_at FROM back_in_stock_subscriptions WHERE id = $1',
      [subId],
    );
    expect(subRow.rows[0]?.status).toBe('ACTIVE');
    expect(subRow.rows[0]?.notified_at).toBeNull();
  });

  it('14. Duplicate event processing does not re-notify already NOTIFIED subscriptions', async () => {
    const { customer1Token, prod1, sku1 } = await setupEcosystem();

    await app.inject({
      method: 'POST',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id, skuId: sku1.id },
    });

    const customerModule = await import('../src/modules/customer/index.js');
    const service = customerModule.customerModule.createBackInStockService(
      db,
      (app as any).log ?? console,
    );

    // First event run
    const res1 = await service.processBackInStockNotification({
      productId: prod1.id,
      skuId: sku1.id,
      eventId: 'evt-1',
    });
    expect(res1.notifiedCount).toBe(1);

    // Duplicate event run
    const res2 = await service.processBackInStockNotification({
      productId: prod1.id,
      skuId: sku1.id,
      eventId: 'evt-1',
    });
    expect(res2.notifiedCount).toBe(0);
  });

  it('15. Wishlist remains independent from back-in-stock subscriptions', async () => {
    const { customer1Token, prod1 } = await setupEcosystem();

    // 1. Add to wishlist
    await app.inject({
      method: 'POST',
      url: '/api/v1/customer/wishlist',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id },
    });

    // 2. Subscribe to back-in-stock
    await app.inject({
      method: 'POST',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id },
    });

    // 3. Cancel back-in-stock
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/customer/back-in-stock/${prod1.id}`,
      headers: { authorization: `Bearer ${customer1Token}` },
    });

    // Wishlist item MUST NOT be deleted
    const wishCheck = await app.inject({
      method: 'GET',
      url: `/api/v1/customer/wishlist/check/${prod1.id}`,
      headers: { authorization: `Bearer ${customer1Token}` },
    });
    expect(wishCheck.json().isWishlisted).toBe(true);
  });

  it('16. Inventory transitions: 0 → positive emits, positive → positive does NOT emit, positive → zero does NOT emit, zero → positive emits again', async () => {
    const { alphaToken, list1 } = await setupEcosystem();

    // 1. Initial restock: 0 → 10 (MUST emit INVENTORY_STOCK_AVAILABLE)
    const initRes = await app.inject({
      method: 'POST',
      url: '/inventory',
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { listingId: list1.id, initialOnHandQuantity: 10 },
    });
    expect(initRes.statusCode).toBe(201);
    const invId = initRes.json().id;

    let availableEvents = await db.query<{ event_type: string; payload: any }>(
      `SELECT event_type, payload FROM outbox_events WHERE event_type = $1 ORDER BY created_at ASC`,
      [EventTypes.INVENTORY_STOCK_AVAILABLE],
    );
    expect(availableEvents.rows.length).toBe(1);
    expect(availableEvents.rows[0]?.payload.availableQuantity).toBe(10);
    expect(availableEvents.rows[0]?.payload.previousAvailableQuantity).toBe(0);

    // 2. Stock increase: 10 → 15 (positive → positive: MUST NOT emit another INVENTORY_STOCK_AVAILABLE)
    const incRes = await app.inject({
      method: 'POST',
      url: `/inventory/${invId}/increase-stock`,
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { quantity: 5, notes: 'Restock batch 2' },
    });
    expect(incRes.statusCode).toBe(200);

    availableEvents = await db.query<{ event_type: string; payload: any }>(
      `SELECT event_type, payload FROM outbox_events WHERE event_type = $1 ORDER BY created_at ASC`,
      [EventTypes.INVENTORY_STOCK_AVAILABLE],
    );
    expect(availableEvents.rows.length).toBe(1); // STILL exactly 1!

    // 3. Stock decrease: 15 → 5 (positive → positive: MUST NOT emit)
    const decRes1 = await app.inject({
      method: 'POST',
      url: `/inventory/${invId}/decrease-stock`,
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { quantity: 10, notes: 'Damaged items removal' },
    });
    expect(decRes1.statusCode).toBe(200);

    availableEvents = await db.query<{ event_type: string; payload: any }>(
      `SELECT event_type, payload FROM outbox_events WHERE event_type = $1 ORDER BY created_at ASC`,
      [EventTypes.INVENTORY_STOCK_AVAILABLE],
    );
    expect(availableEvents.rows.length).toBe(1); // STILL exactly 1!

    // 4. Stock decrease: 5 → 0 (positive → zero: MUST NOT emit)
    const decRes2 = await app.inject({
      method: 'POST',
      url: `/inventory/${invId}/decrease-stock`,
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { quantity: 5, notes: 'Cleared out remaining' },
    });
    expect(decRes2.statusCode).toBe(200);

    availableEvents = await db.query<{ event_type: string; payload: any }>(
      `SELECT event_type, payload FROM outbox_events WHERE event_type = $1 ORDER BY created_at ASC`,
      [EventTypes.INVENTORY_STOCK_AVAILABLE],
    );
    expect(availableEvents.rows.length).toBe(1); // STILL exactly 1!

    // 5. Stock increase from zero: 0 → 3 (zero → positive: MUST emit INVENTORY_STOCK_AVAILABLE again!)
    const incRes2 = await app.inject({
      method: 'POST',
      url: `/inventory/${invId}/increase-stock`,
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { quantity: 3, notes: 'New delivery arrived' },
    });
    expect(incRes2.statusCode).toBe(200);

    availableEvents = await db.query<{ event_type: string; payload: any }>(
      `SELECT event_type, payload FROM outbox_events WHERE event_type = $1 ORDER BY created_at ASC`,
      [EventTypes.INVENTORY_STOCK_AVAILABLE],
    );
    expect(availableEvents.rows.length).toBe(2); // Exactly 2 events total now!
    expect(availableEvents.rows[1]?.payload.availableQuantity).toBe(3);
    expect(availableEvents.rows[1]?.payload.previousAvailableQuantity).toBe(0);
  });

  it('17. Crash window & durable application-level idempotency: notification succeeds but DB update crashes -> retry prevents duplicate notification', async () => {
    const { customer1Token, prod1, sku1 } = await setupEcosystem();

    // 1. Customer subscribes while out of stock
    const subRes = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id, skuId: sku1.id },
    });
    expect(subRes.statusCode).toBe(201);
    const subId = subRes.json().id;

    // 2. Setup real NotificationService with a spy on email provider
    const emailProvider = new InMemoryEmailProvider();
    const smsProvider = new InMemorySmsProvider();
    const pushProvider = new InMemoryPushProvider();
    const notifRepo = new NotificationRepository();
    const notifLogger = (app as any).log ?? console;

    const emailSpy = vi.spyOn(emailProvider, 'sendEmail');

    const notifService = new NotificationService(
      db,
      notifRepo,
      emailProvider,
      smsProvider,
      pushProvider,
      notifLogger,
    );

    // 3. Create service and simulate crash window:
    // First run: Notification delivery succeeds (email is sent, notification record marked SENT in DB),
    // but the transaction updating subscription state crashes / does not complete.
    const customerModule = await import('../src/modules/customer/index.js');
    const service = customerModule.customerModule.createBackInStockService(
      db,
      notifLogger,
      notifService,
      undefined,
      'http://localhost:3000',
    );

    // Mock the repository's markSubscriptionNotified to fail on the first run to simulate crash right after notification dispatch
    const originalMark = (service as any).repo.markSubscriptionNotified.bind((service as any).repo);
    let simulateCrash = true;
    vi.spyOn((service as any).repo as { markSubscriptionNotified: any }, 'markSubscriptionNotified').mockImplementation(async (tx: any, id: any) => {
      if (simulateCrash) {
        throw new Error('SIMULATED CRASH: Database connection dropped before subscription update committed');
      }
      return originalMark(tx, id);
    });

    // Run first attempt: will send email, then fail during subscription update
    await expect(
      service.processBackInStockNotification({
        productId: prod1.id,
        skuId: sku1.id,
        eventId: 'evt-crash-test-1',
      }),
    ).rejects.toThrow('SIMULATED CRASH');

    // Verify state after crash:
    // Email WAS sent once to the provider:
    expect(emailSpy).toHaveBeenCalledTimes(1);

    // But subscription remains ACTIVE in the database:
    const subAfterCrash = await db.query<{ status: string; notified_at: string | null }>(
      'SELECT status, notified_at FROM back_in_stock_subscriptions WHERE id = $1',
      [subId],
    );
    expect(subAfterCrash.rows[0]?.status).toBe('ACTIVE');

    // 4. Second attempt (consumer retry / worker recovery after crash):
    simulateCrash = false; // crash is resolved, worker retries processing

    const retryResult = await service.processBackInStockNotification({
      productId: prod1.id,
      skuId: sku1.id,
      eventId: 'evt-crash-test-1', // or redelivered event
    });

    // CRITICAL INVARIANT: The durable application-level idempotency key (tied to subscription id)
    // prevented duplicate email delivery to the provider!
    expect(emailSpy).toHaveBeenCalledTimes(1); // STILL EXACTLY 1 CALL! NOT DUPLICATED!
    expect(retryResult.notifiedCount).toBe(1);

    // And the subscription is now successfully marked NOTIFIED:
    const subAfterRetry = await db.query<{ status: string; notified_at: string | null }>(
      'SELECT status, notified_at FROM back_in_stock_subscriptions WHERE id = $1',
      [subId],
    );
    expect(subAfterRetry.rows[0]?.status).toBe('NOTIFIED');
    expect(subAfterRetry.rows[0]?.notified_at).toBeTruthy();
  });

  it('18. Replayed inventory event to consumer does not send duplicate notifications', async () => {
    const { customer1Token, prod1, sku1 } = await setupEcosystem();

    // Customer subscribes
    await app.inject({
      method: 'POST',
      url: '/api/v1/customer/back-in-stock',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { productId: prod1.id, skuId: sku1.id },
    });

    const emailProvider = new InMemoryEmailProvider();
    const smsProvider = new InMemorySmsProvider();
    const pushProvider = new InMemoryPushProvider();
    const notifRepo = new NotificationRepository();
    const notifLogger = (app as any).log ?? console;

    const emailSpy = vi.spyOn(emailProvider, 'sendEmail');

    const notifService = new NotificationService(
      db,
      notifRepo,
      emailProvider,
      smsProvider,
      pushProvider,
      notifLogger,
    );

    const customerModule = await import('../src/modules/customer/index.js');
    const service = customerModule.customerModule.createBackInStockService(
      db,
      notifLogger,
      notifService,
      undefined,
      'http://localhost:3000',
    );

    // First event delivery
    const run1 = await service.processBackInStockNotification({
      productId: prod1.id,
      skuId: sku1.id,
      eventId: 'evt-replay-1',
    });
    expect(run1.notifiedCount).toBe(1);
    expect(emailSpy).toHaveBeenCalledTimes(1);

    // Replayed event delivery
    const run2 = await service.processBackInStockNotification({
      productId: prod1.id,
      skuId: sku1.id,
      eventId: 'evt-replay-1',
    });
    expect(run2.notifiedCount).toBe(0);
    expect(emailSpy).toHaveBeenCalledTimes(1); // No second email
  });
});
