import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase, markAllUsersVerified, registerVerifiedUser } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

describe('Phase 5: Checkout Domain & Orchestration (Multi-Item Reservation & Compensation)', () => {
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

    // 3. Merchant Beta
    const betaToken = await registerVerifiedUser(app, db, {
      email: 'beta@store.com',
      password: 'Password123!',
      tenantName: 'Merchant Beta Store',
      role: 'MERCHANT',
    });

    await app.inject({
      method: 'POST',
      url: '/merchants/onboard',
      headers: { authorization: `Bearer ${betaToken}` },
      payload: { businessName: 'Beta LLC', legalName: 'Beta Legal', contactEmail: 'beta@biz.com' },
    });
    await app.inject({ method: 'POST', url: '/merchants/me/submit', headers: { authorization: `Bearer ${betaToken}` } });
    const profB = (await app.inject({ method: 'GET', url: '/merchants/me', headers: { authorization: `Bearer ${betaToken}` } })).json();
    await app.inject({ method: 'POST', url: `/merchants/${profB.tenantId}/approve`, headers: { authorization: `Bearer ${adminToken}` } });

    // 4. Customers
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

    // 5. Catalog: Category, Products, SKUs
    const cat = (
      await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Wearables', slug: 'wearables' },
      })
    ).json();

    const prod = (
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'Smart Watch', slug: 'smart-watch', categoryId: cat.id },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/products/${prod.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    const sku1 = (
      await app.inject({
        method: 'POST',
        url: `/products/${prod.id}/skus`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { skuCode: 'SW-BLK', attributes: { color: 'Black' } },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/skus/${sku1.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    const sku2 = (
      await app.inject({
        method: 'POST',
        url: `/products/${prod.id}/skus`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { skuCode: 'SW-GLD', attributes: { color: 'Gold' } },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/skus/${sku2.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    // 6. Listings:
    // Merchant Alpha listing for SKU 1: ₹5,000 (500000 paise)
    const listA = (
      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { skuId: sku1.id, priceAmount: 500000, currency: 'INR' },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/listings/${listA.id}/status`,
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { status: 'ACTIVE' },
    });

    // Merchant Beta listing for SKU 2: ₹6,000 (600000 paise)
    const listB = (
      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${betaToken}` },
        payload: { skuId: sku2.id, priceAmount: 600000, currency: 'INR' },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/listings/${listB.id}/status`,
      headers: { authorization: `Bearer ${betaToken}` },
      payload: { status: 'ACTIVE' },
    });

    // 7. Inventory:
    // Alpha stock: 10 on-hand
    const invA = (
      await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { listingId: listA.id, initialOnHandQuantity: 10 },
      })
    ).json();

    // Beta stock: 5 on-hand
    const invB = (
      await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${betaToken}` },
        payload: { listingId: listB.id, initialOnHandQuantity: 5 },
      })
    ).json();

    return {
      adminToken,
      alphaToken,
      betaToken,
      customer1Token,
      customer2Token,
      listingAlpha: listA,
      listingBeta: listB,
      invA,
      invB,
      prod,
      sku1,
    };
  }

  describe('Checkout Session Creation & Validation', () => {
    it('rejects checkout creation when cart is empty', async () => {
      const { customer1Token } = await setupEcosystem();

      const res = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${customer1Token}` },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('EMPTY_CART');
    });

    it('creates checkout session from active multi-vendor cart with immutable pricing snapshot', async () => {
      const { customer1Token, listingAlpha, listingBeta } = await setupEcosystem();

      // Add 2 units from Alpha (2 x ₹5,000 = ₹10,000)
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingAlpha.id, quantity: 2 },
      });

      // Add 1 unit from Beta (1 x ₹6,000 = ₹6,000)
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingBeta.id, quantity: 1 },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { idempotencyKey: 'session-idempotent-1' },
      });

      expect(res.statusCode).toBe(201);
      const session = res.json();
      expect(session.id).toBeDefined();
      expect(session.status).toBe('OPEN');
      expect(session.currency).toBe('INR');

      // Integer minor-unit financial calculations
      // Subtotal = 1000000 + 600000 = 1600000 paise (₹16,000)
      expect(session.subtotalAmount).toBe(1600000);
      expect(session.totalAmount).toBe(1600000);
      expect(session.discountAmount).toBe(0);
      expect(session.shippingAmount).toBe(0);
      expect(session.taxAmount).toBe(0);

      // Verify immutable items snapshot
      expect(session.items.length).toBe(2);
      const itemA = session.items.find((i: { listingId: string }) => i.listingId === listingAlpha.id);
      const itemB = session.items.find((i: { listingId: string }) => i.listingId === listingBeta.id);

      expect(itemA.merchantTenantId).toBe(listingAlpha.tenantId);
      expect(itemA.quantity).toBe(2);
      expect(itemA.unitPriceAmount).toBe(500000);
      expect(itemA.lineTotalAmount).toBe(1000000);
      expect(itemA.inventoryReservationId).toBeNull();

      expect(itemB.merchantTenantId).toBe(listingBeta.tenantId);
      expect(itemB.quantity).toBe(1);
      expect(itemB.unitPriceAmount).toBe(600000);
      expect(itemB.lineTotalAmount).toBe(600000);
      expect(itemB.inventoryReservationId).toBeNull();
    });

    it('rejects checkout session creation if a listing is inactive or has insufficient inventory', async () => {
      const { customer1Token, listingAlpha, alphaToken } = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingAlpha.id, quantity: 2 },
      });

      // Merchant suspends listing
      await app.inject({
        method: 'POST',
        url: `/listings/${listingAlpha.id}/status`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { status: 'INACTIVE' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${customer1Token}` },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('CHECKOUT_VALIDATION_FAILED');
      expect(res.json().error.message).toContain('is not active');
    });

    it('returns existing checkout session idempotently when called with same idempotency key', async () => {
      const { customer1Token, listingAlpha } = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingAlpha.id, quantity: 1 },
      });

      const res1 = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { idempotencyKey: 'idemp-checkout-key-99' },
      });
      expect(res1.statusCode).toBe(201);
      const session1 = res1.json();

      const res2 = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { idempotencyKey: 'idemp-checkout-key-99' },
      });
      expect(res2.statusCode).toBe(201);
      const session2 = res2.json();

      expect(session2.id).toBe(session1.id);
    });
  });

  describe('Inventory Reservation Orchestration & Multi-Item Compensation', () => {
    it('successfully reserves inventory for all items in multi-vendor checkout and marks session READY', async () => {
      const { customer1Token, listingAlpha, listingBeta, invA, invB, alphaToken, betaToken } = await setupEcosystem();

      // Add items
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingAlpha.id, quantity: 3 },
      });
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingBeta.id, quantity: 2 },
      });

      const sessionRes = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${customer1Token}` },
      });
      const session = sessionRes.json();

      // Trigger inventory reservation orchestration
      const reserveRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${customer1Token}` },
      });

      expect(reserveRes.statusCode).toBe(200);
      const readySession = reserveRes.json();
      expect(readySession.status).toBe('READY');
      expect(readySession.reservedAt).toBeDefined();

      // Both items have valid inventory reservation IDs
      for (const item of readySession.items) {
        expect(item.inventoryReservationId).toBeDefined();
        expect(item.inventoryReservationId).not.toBeNull();
      }

      // Verify authoritative inventory stock in Inventory context:
      // Merchant Alpha: On-Hand 10, Reserved 3, Available 7
      const invAlphaRes = await app.inject({
        method: 'GET',
        url: `/inventory/${invA.id}`,
        headers: { authorization: `Bearer ${alphaToken}` },
      });
      expect(invAlphaRes.json().reservedQuantity).toBe(3);
      expect(invAlphaRes.json().availableQuantity).toBe(7);

      // Merchant Beta: On-Hand 5, Reserved 2, Available 3
      const invBetaRes = await app.inject({
        method: 'GET',
        url: `/inventory/${invB.id}`,
        headers: { authorization: `Bearer ${betaToken}` },
      });
      expect(invBetaRes.json().reservedQuantity).toBe(2);
      expect(invBetaRes.json().availableQuantity).toBe(3);

      // Calling reserve again is idempotent and returns READY without double reservation
      const reReserve = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${customer1Token}` },
      });
      expect(reReserve.statusCode).toBe(200);
      expect(reReserve.json().status).toBe('READY');
      const invAlphaAfter = await app.inject({
        method: 'GET',
        url: `/inventory/${invA.id}`,
        headers: { authorization: `Bearer ${alphaToken}` },
      });
      expect(invAlphaAfter.json().reservedQuantity).toBe(3); // NO DOUBLE RESERVATION
    });

    it('COMPENSATION GUARANTEE: releases already-acquired reservations if a later item in checkout fails reservation', async () => {
      const {
        customer1Token,
        listingAlpha,
        listingBeta,
        invA,
        invB,
        alphaToken,
        betaToken,
      } = await setupEcosystem();

      // Setup scenario:
      // Item A (Merchant Alpha): 2 units requested (10 available) -> WILL SUCCEED
      // Item B (Merchant Beta): 10 units requested (only 5 available!) -> WILL FAIL
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingAlpha.id, quantity: 2 },
      });
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingBeta.id, quantity: 10 },
      });

      // Directly update cart item quantity to simulate concurrency race where stock was depleted after cart addition
      // Now create checkout session
      // For testing compensation specifically, we deplete Beta inventory right after session creation
      await app.inject({
        method: 'DELETE',
        url: '/cart',
        headers: { authorization: `Bearer ${customer1Token}` },
      });
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingAlpha.id, quantity: 2 },
      });
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingBeta.id, quantity: 4 },
      });

      // Checkout session created successfully
      const sessionRes = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${customer1Token}` },
      });
      expect(sessionRes.statusCode).toBe(201);
      const session = sessionRes.json();

      // Now deplete Beta inventory to 1 before reserve is called so Beta reservation fails!
      // Decrease Beta on-hand by 4 (5 - 4 = 1 on-hand)
      const decRes = await app.inject({
        method: 'POST',
        url: `/inventory/${invB.id}/decrease-stock`,
        headers: { authorization: `Bearer ${betaToken}` },
        payload: { quantity: 4, notes: 'Sold offline flash restock' },
      });
      expect(decRes.statusCode).toBe(200);

      // Attempt to reserve checkout:
      // Item A (Alpha) needs 2 units (10 available) -> succeeds first
      // Item B (Beta) needs 4 units (only 1 available) -> FAILS!
      const reserveRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${customer1Token}` },
      });

      // Must fail with 409
      expect(reserveRes.statusCode).toBe(409);
      expect(reserveRes.json().error.code).toBe('INSUFFICIENT_INVENTORY');

      // Check session status: must be FAILED
      const sessionCheck = await app.inject({
        method: 'GET',
        url: `/checkout/sessions/${session.id}`,
        headers: { authorization: `Bearer ${customer1Token}` },
      });
      expect(sessionCheck.json().status).toBe('FAILED');
      expect(sessionCheck.json().failureReason).toContain('Insufficient inventory');

      // CRITICAL COMPENSATION VERIFICATION:
      // Item A reservation MUST BE RELEASED!
      // Reserved quantity for Merchant Alpha must be 0, available must be 10!
      const invAlphaCheck = await app.inject({
        method: 'GET',
        url: `/inventory/${invA.id}`,
        headers: { authorization: `Bearer ${alphaToken}` },
      });
      expect(invAlphaCheck.json().reservedQuantity).toBe(0); // COMPENSATION RELEASED IT!
      expect(invAlphaCheck.json().availableQuantity).toBe(10); // ZERO LEAKED INVENTORY!

      // Merchant Beta inventory is also unreserved
      const invBetaCheck = await app.inject({
        method: 'GET',
        url: `/inventory/${invB.id}`,
        headers: { authorization: `Bearer ${betaToken}` },
      });
      expect(invBetaCheck.json().reservedQuantity).toBe(0);
      expect(invBetaCheck.json().availableQuantity).toBe(1);
    });

    it('expires checkout session and releases reserved inventory back to availability', async () => {
      const { customer1Token, listingAlpha, invA, alphaToken } = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingAlpha.id, quantity: 4 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${customer1Token}` },
        })
      ).json();

      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${customer1Token}` },
      });

      // Alpha inventory reserved = 4, available = 6
      const invBefore = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${invA.id}`,
          headers: { authorization: `Bearer ${alphaToken}` },
        })
      ).json();
      expect(invBefore.reservedQuantity).toBe(4);
      expect(invBefore.availableQuantity).toBe(6);

      // Expire session
      const expireRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/expire`,
        headers: { authorization: `Bearer ${customer1Token}` },
      });
      expect(expireRes.statusCode).toBe(200);
      expect(expireRes.json().status).toBe('EXPIRED');

      // Alpha inventory restored: reserved = 0, available = 10
      const invAfter = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${invA.id}`,
          headers: { authorization: `Bearer ${alphaToken}` },
        })
      ).json();
      expect(invAfter.reservedQuantity).toBe(0);
      expect(invAfter.availableQuantity).toBe(10);
    });

    it('cancels checkout session and releases reserved inventory back to availability', async () => {
      const { customer1Token, listingAlpha, invA, alphaToken } = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingAlpha.id, quantity: 2 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${customer1Token}` },
        })
      ).json();

      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${customer1Token}` },
      });

      // Cancel session
      const cancelRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/cancel`,
        headers: { authorization: `Bearer ${customer1Token}` },
      });
      expect(cancelRes.statusCode).toBe(200);
      expect(cancelRes.json().status).toBe('CANCELLED');

      // Alpha inventory restored: reserved = 0, available = 10
      const invAfter = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${invA.id}`,
          headers: { authorization: `Bearer ${alphaToken}` },
        })
      ).json();
      expect(invAfter.reservedQuantity).toBe(0);
      expect(invAfter.availableQuantity).toBe(10);
    });
  });

  describe('Tenant Isolation & RBAC', () => {
    it('prevents Customer A from accessing or mutating Customer B checkout session', async () => {
      const { customer1Token, customer2Token, listingAlpha } = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingAlpha.id, quantity: 1 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${customer1Token}` },
        })
      ).json();

      // Customer 2 attempts to read Customer 1 session
      const readRes = await app.inject({
        method: 'GET',
        url: `/checkout/sessions/${session.id}`,
        headers: { authorization: `Bearer ${customer2Token}` },
      });
      expect(readRes.statusCode).toBe(403);

      // Customer 2 attempts to reserve Customer 1 session
      const resRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${customer2Token}` },
      });
      expect(resRes.statusCode).toBe(403);
    });

    it('prevents merchants from creating or manipulating checkout sessions', async () => {
      const { alphaToken } = await setupEcosystem();

      const res = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${alphaToken}` },
      });
      // Merchant lacks checkout:create-own permission
      expect(res.statusCode).toBe(403);
    });
  });
});
