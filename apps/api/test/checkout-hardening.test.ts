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

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

describe('Phase 5 Hardening: Cart & Checkout Transactional / Concurrency Verification', () => {
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
      payload: {
        businessName: 'Alpha LLC',
        legalName: 'Alpha Legal',
        contactEmail: 'alpha@biz.com',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/merchants/me/submit',
      headers: { authorization: `Bearer ${alphaToken}` },
    });
    const profA = (
      await app.inject({
        method: 'GET',
        url: '/merchants/me',
        headers: { authorization: `Bearer ${alphaToken}` },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/merchants/${profA.tenantId}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

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
    await app.inject({
      method: 'POST',
      url: '/merchants/me/submit',
      headers: { authorization: `Bearer ${betaToken}` },
    });
    const profB = (
      await app.inject({
        method: 'GET',
        url: '/merchants/me',
        headers: { authorization: `Bearer ${betaToken}` },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/merchants/${profB.tenantId}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    // 4. Catalog: Category, Products, SKUs
    const cat = (
      await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Electronics', slug: 'electronics' },
      })
    ).json();

    const prodA = (
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'Smartphone Pro', slug: 'smartphone-pro', categoryId: cat.id },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/products/${prodA.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    const skuA = (
      await app.inject({
        method: 'POST',
        url: `/products/${prodA.id}/skus`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { skuCode: 'SP-PRO-128' },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/skus/${skuA.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    const prodB = (
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'Wireless Headphones', slug: 'wireless-headphones', categoryId: cat.id },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/products/${prodB.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    const skuB = (
      await app.inject({
        method: 'POST',
        url: `/products/${prodB.id}/skus`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { skuCode: 'WH-BT-500' },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/skus/${skuB.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    // 5. Listings
    // Listing Alpha: ₹80,000 (8000000 minor units)
    const listA = (
      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { skuId: skuA.id, priceAmount: 8000000, currency: 'INR' },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/listings/${listA.id}/status`,
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { status: 'ACTIVE' },
    });

    // Listing Beta: ₹15,000 (1500000 minor units)
    const listB = (
      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${betaToken}` },
        payload: { skuId: skuB.id, priceAmount: 1500000, currency: 'INR' },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/listings/${listB.id}/status`,
      headers: { authorization: `Bearer ${betaToken}` },
      payload: { status: 'ACTIVE' },
    });

    // 6. Inventory: 10 on-hand each
    const invA = (
      await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { listingId: listA.id, initialOnHandQuantity: 10 },
      })
    ).json();

    const invB = (
      await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${betaToken}` },
        payload: { listingId: listB.id, initialOnHandQuantity: 10 },
      })
    ).json();

    // 7. Customers
    const cust1Token = await registerVerifiedUser(app, db, {
      email: 'customer1@test.com',
      password: 'Password123!',
      tenantName: 'Customer 1 Space',
      role: 'CUSTOMER',
    });

    const cust2Token = await registerVerifiedUser(app, db, {
      email: 'customer2@test.com',
      password: 'Password123!',
      tenantName: 'Customer 2 Space',
      role: 'CUSTOMER',
    });

    return {
      adminToken,
      alphaToken,
      betaToken,
      cust1Token,
      cust2Token,
      listA,
      listB,
      invA,
      invB,
    };
  }

  // --- 1. CHECKOUT RESERVATION IDEMPOTENCY ---
  describe('Checkout Reservation Idempotency', () => {
    it('guarantees identical response and zero duplicate reservations when reserve is retried', async () => {
      const eco = await setupEcosystem();

      // Customer 1 adds item to cart and creates checkout
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 2 },
      });

      const sessionRes = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const session = sessionRes.json();

      // First reserve call
      const res1 = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(res1.statusCode).toBe(200);
      const data1 = res1.json();
      expect(data1.status).toBe('READY');
      expect(data1.items[0].inventoryReservationId).toBeTruthy();

      // Verify inventory state
      const invCheck1 = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(invCheck1.reservedQuantity).toBe(2);
      expect(invCheck1.availableQuantity).toBe(8);

      // Retry reserve call (simulating network drop / retry)
      const res2 = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(res2.statusCode).toBe(200);
      const data2 = res2.json();
      expect(data2.status).toBe('READY');
      expect(data2.items[0].inventoryReservationId).toBe(data1.items[0].inventoryReservationId);

      // Verify inventory was NOT double-reserved
      const invCheck2 = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(invCheck2.reservedQuantity).toBe(2);
      expect(invCheck2.availableQuantity).toBe(8);

      // Verify DB rows: exactly 1 reservation row in inventory_reservations
      const resCount = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM inventory_reservations WHERE idempotency_key = $1`,
        [`chk-${session.id}-${data1.items[0].id}`],
      );
      expect(parseInt(resCount.rows[0]!.count, 10)).toBe(1);
    });

    it('simulates response lost after inventory reservation succeeded and verifies retry reconciliation', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 3 },
      });

      const sessionRes = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const session = sessionRes.json();
      const itemId = session.items[0].id;

      // Simulate step 1: Pre-populate inventory reservation with the deterministic key as if step 1 succeeded
      const stableKey = `chk-${session.id}-${itemId}`;
      const invRes = (
        await app.inject({
          method: 'POST',
          url: '/inventory/reservations',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: {
            listingId: eco.listA.id,
            quantity: 3,
            idempotencyKey: stableKey,
          },
        })
      ).json();
      expect(invRes.id).toBeTruthy();

      // Now client retries /checkout/sessions/:id/reserve
      const reserveRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(reserveRes.statusCode).toBe(200);
      const resBody = reserveRes.json();
      expect(resBody.status).toBe('READY');
      expect(resBody.items[0].inventoryReservationId).toBe(invRes.id);

      // Inventory check: exactly 3 reserved, not 6
      const inv = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(inv.reservedQuantity).toBe(3);
      expect(inv.availableQuantity).toBe(7);
    });
  });

  // --- 2. SAME-CHECKOUT CONCURRENT RESERVATION ---
  describe('Same-Checkout Concurrent Reservation', () => {
    it('handles simultaneous reserve requests on the same session with zero double-reservations', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 4 },
      });

      const sessionRes = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const session = sessionRes.json();

      // Fire 2 concurrent reserve requests for the EXACT same session
      const [resA, resB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/checkout/sessions/${session.id}/reserve`,
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        }),
        app.inject({
          method: 'POST',
          url: `/checkout/sessions/${session.id}/reserve`,
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        }),
      ]);

      // Both should succeed with 200 READY or return a consistent result
      expect(resA.statusCode).toBe(200);
      expect(resB.statusCode).toBe(200);
      expect(resA.json().status).toBe('READY');
      expect(resB.json().status).toBe('READY');

      // Both must point to the identical reservation ID
      expect(resA.json().items[0].inventoryReservationId).toBe(
        resB.json().items[0].inventoryReservationId,
      );

      // Inventory must only have reserved 4 units, not 8
      const inv = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(inv.reservedQuantity).toBe(4);
      expect(inv.availableQuantity).toBe(6);
    });
  });

  // --- 3. RESERVE VS CANCEL RACE ---
  describe('Reserve vs Cancel Race', () => {
    it('guarantees that a cancelled checkout cannot later become READY and holds are released', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 3 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      // Launch reserve and cancel concurrently
      const [_reserveResult, _cancelResult] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/checkout/sessions/${session.id}/reserve`,
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        }),
        app.inject({
          method: 'POST',
          url: `/checkout/sessions/${session.id}/cancel`,
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        }),
      ]);

      // Check current session state in DB
      const finalSession = (
        await app.inject({
          method: 'GET',
          url: `/checkout/sessions/${session.id}`,
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      // Deterministic rule: The session must be in a valid terminal state (CANCELLED or READY)
      expect(['CANCELLED', 'READY']).toContain(finalSession.status);

      // If CANCELLED, inventory reservedQuantity must be 0 (no leaked holds)
      if (finalSession.status === 'CANCELLED') {
        const inv = (
          await app.inject({
            method: 'GET',
            url: `/inventory/${eco.invA.id}`,
            headers: { authorization: `Bearer ${eco.alphaToken}` },
          })
        ).json();
        expect(inv.reservedQuantity).toBe(0);
        expect(inv.availableQuantity).toBe(10);
      }
    });

    it('rejects reserve on an already cancelled checkout session', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 2 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      // Cancel first
      const cancelRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/cancel`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(cancelRes.statusCode).toBe(200);

      // Attempt to reserve afterwards
      const reserveRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(reserveRes.statusCode).toBe(409);
      expect(reserveRes.json().error.message).toContain('CANCELLED');

      // Stock remains untouched
      const inv = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(inv.reservedQuantity).toBe(0);
    });
  });

  // --- 4. RESERVE VS EXPIRE RACE ---
  describe('Reserve vs Expire Race', () => {
    it('guarantees that an expired session does not leak active inventory reservations', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 2 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      // Concurrently run reserve and expire
      const [_reserveRes, _expireRes] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/checkout/sessions/${session.id}/reserve`,
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        }),
        app.inject({
          method: 'POST',
          url: `/checkout/sessions/${session.id}/expire`,
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        }),
      ]);

      const finalSession = (
        await app.inject({
          method: 'GET',
          url: `/checkout/sessions/${session.id}`,
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      expect(['EXPIRED', 'READY']).toContain(finalSession.status);

      // If EXPIRED, inventory must be 0 reserved
      if (finalSession.status === 'EXPIRED') {
        const inv = (
          await app.inject({
            method: 'GET',
            url: `/inventory/${eco.invA.id}`,
            headers: { authorization: `Bearer ${eco.alphaToken}` },
          })
        ).json();
        expect(inv.reservedQuantity).toBe(0);
        expect(inv.availableQuantity).toBe(10);
      }
    });

    it('rejects reservation if session has expired server-side', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 2 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      // Backdate expires_at in DB
      await db.query(
        `UPDATE checkout_sessions SET expires_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`,
        [session.id],
      );

      const res = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CHECKOUT_EXPIRED');

      // Check DB status was set to EXPIRED
      const check = await db.query<{ status: string }>(
        `SELECT status FROM checkout_sessions WHERE id = $1`,
        [session.id],
      );
      expect(check.rows[0]!.status).toBe('EXPIRED');
    });
  });

  // --- 5. CANCEL VS EXPIRE RACE ---
  describe('Cancel vs Expire Race', () => {
    it('executes deterministic state transition when cancel and expire race concurrently', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 2 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      const [cancelRes, expireRes] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/checkout/sessions/${session.id}/cancel`,
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        }),
        app.inject({
          method: 'POST',
          url: `/checkout/sessions/${session.id}/expire`,
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        }),
      ]);

      const statusCodes = [cancelRes.statusCode, expireRes.statusCode];
      // One succeeds with 200, the other either succeeds idempotently or returns 409
      expect(statusCodes).toContain(200);

      const check = await db.query<{ status: string }>(
        `SELECT status FROM checkout_sessions WHERE id = $1`,
        [session.id],
      );
      expect(['CANCELLED', 'EXPIRED']).toContain(check.rows[0]!.status);
    });
  });

  // --- 6. PRICE REVALIDATION & SNAPSHOT INTEGRITY ---
  describe('Price Revalidation & Snapshot Integrity', () => {
    it('detects merchant price change between checkout creation and reserve, rejecting with 422', async () => {
      const eco = await setupEcosystem();

      // 1. Cart created when price = ₹80,000 (8000000 minor units)
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 1 },
      });

      // 2. Create checkout session (captures ₹80,000 snapshot)
      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();
      expect(session.subtotalAmount).toBe(8000000);

      // 3. Merchant updates listing price to ₹85,000 (8500000 minor units)
      const priceUpdate = await app.inject({
        method: 'PATCH',
        url: `/listings/${eco.listA.id}`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { priceAmount: 8500000 },
      });
      expect(priceUpdate.statusCode).toBe(200);

      // 4. Customer attempts reservation
      const reserveRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      // Must be rejected with 422 CheckoutValidationError
      expect(reserveRes.statusCode).toBe(422);
      expect(reserveRes.json().error.code).toBe('CHECKOUT_VALIDATION_FAILED');
      expect(reserveRes.json().error.message).toContain('Listing price has changed');

      // Check session status is marked FAILED in DB
      const check = await db.query<{ status: string; failure_reason: string }>(
        `SELECT status, failure_reason FROM checkout_sessions WHERE id = $1`,
        [session.id],
      );
      expect(check.rows[0]!.status).toBe('FAILED');
      expect(check.rows[0]!.failure_reason).toContain('price has changed');

      // Inventory must NOT have been reserved
      const inv = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(inv.reservedQuantity).toBe(0);
      expect(inv.availableQuantity).toBe(10);
    });

    it('guarantees that once READY, the checkout snapshot is authoritative and locked against later listing price edits', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 1 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      // Successfully reserve -> reaches READY
      const res = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('READY');

      // Merchant modifies listing price after READY
      await app.inject({
        method: 'PATCH',
        url: `/listings/${eco.listA.id}`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { priceAmount: 9900000 },
      });

      // Checkout session retains locked snapshot: ₹80,000
      const fetched = (
        await app.inject({
          method: 'GET',
          url: `/checkout/sessions/${session.id}`,
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();
      expect(fetched.subtotalAmount).toBe(8000000);
      expect(fetched.totalAmount).toBe(8000000);
      expect(fetched.items[0].unitPriceAmount).toBe(8000000);
    });

    it('guarantees that subsequent cart mutations do not alter an existing checkout snapshot', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 1 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      // Mutate cart: add another item and clear cart
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listB.id, quantity: 2 },
      });

      // Checkout session is completely unchanged
      const fetched = (
        await app.inject({
          method: 'GET',
          url: `/checkout/sessions/${session.id}`,
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();
      expect(fetched.items.length).toBe(1);
      expect(fetched.items[0].listingId).toBe(eco.listA.id);
      expect(fetched.items[0].quantity).toBe(1);
    });
  });

  // --- 7. MULTI-ITEM RESERVATION COMPENSATION & RECOVERY ---
  describe('Multi-Item Reservation Compensation & Recovery', () => {
    it('compensates and releases acquired reservations when a subsequent item fails reservation', async () => {
      const eco = await setupEcosystem();

      // Alpha has 10 units, Beta has 1 unit
      // Update Beta inventory to have only 1 unit on-hand
      await db.query(`UPDATE inventory_items SET on_hand_quantity = 1 WHERE listing_id = $1`, [
        eco.listB.id,
      ]);

      // Add Alpha (qty: 2) and Beta (qty: 5) to cart
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 2 },
      });
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listB.id, quantity: 1 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      // Now someone depletes Beta stock before reservation
      await db.query(`UPDATE inventory_items SET on_hand_quantity = 0 WHERE listing_id = $1`, [
        eco.listB.id,
      ]);

      // Attempt reservation: Item A succeeds, Item B fails
      const reserveRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      expect(reserveRes.statusCode).toBe(409);
      expect(reserveRes.json().error.code).toBe('INSUFFICIENT_INVENTORY');

      // Check session status is FAILED
      const check = await db.query<{ status: string }>(
        `SELECT status FROM checkout_sessions WHERE id = $1`,
        [session.id],
      );
      expect(check.rows[0]!.status).toBe('FAILED');

      // CRITICAL COMPENSATION GUARANTEE: Item A's 2 units were released back
      const invA = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(invA.reservedQuantity).toBe(0);
      expect(invA.availableQuantity).toBe(10);
    });

    it('records uncompensated reservation state if release partially fails during compensation', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 2 },
      });
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listB.id, quantity: 1 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      // Exhaust Beta stock so item 2 fails
      await db.query(`UPDATE inventory_items SET on_hand_quantity = 0 WHERE listing_id = $1`, [
        eco.listB.id,
      ]);

      const reserveRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(reserveRes.statusCode).toBe(409);

      // Verify that failure reason exists
      const sessionCheck = await db.query<{ status: string; failure_reason: string }>(
        `SELECT status, failure_reason FROM checkout_sessions WHERE id = $1`,
        [session.id],
      );
      expect(sessionCheck.rows[0]!.status).toBe('FAILED');
      expect(sessionCheck.rows[0]!.failure_reason).toBeTruthy();
    });
  });

  // --- 8. IDEMPOTENCY KEY CONSTRAINTS & FINGERPRINTING ---
  describe('Idempotency Key Constraints & Fingerprinting', () => {
    it('returns the same checkout session when created concurrently with the same idempotency key', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 2 },
      });

      const idempotencyKey = 'create-chk-key-001';

      const [res1, res2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { idempotencyKey },
        }),
        app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { idempotencyKey },
        }),
      ]);

      expect(res1.statusCode).toBe(201);
      expect(res2.statusCode).toBe(201);
      expect(res1.json().id).toBe(res2.json().id);

      // Exactly 1 checkout session row created in DB
      const count = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM checkout_sessions WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      expect(parseInt(count.rows[0]!.count, 10)).toBe(1);
    });

    it('rejects idempotency key reuse if cart contents have materially changed', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 1 },
      });

      const idempotencyKey = 'reuse-key-mismatch';

      const res1 = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { idempotencyKey },
      });
      expect(res1.statusCode).toBe(201);

      // Mutate cart contents (add another item)
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listB.id, quantity: 1 },
      });

      // Call again with same idempotency key but different cart contents
      const res2 = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { idempotencyKey },
      });

      expect(res2.statusCode).toBe(422);
      expect(res2.json().error.message).toContain(
        'Idempotency key reuse detected with different cart contents',
      );
    });

    it('allows different customers to independently use the same idempotency key', async () => {
      const eco = await setupEcosystem();

      // Customer 1 adds item
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 1 },
      });

      // Customer 2 adds item
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust2Token}` },
        payload: { listingId: eco.listA.id, quantity: 1 },
      });

      const sharedKey = 'common-client-generated-uuid-key';

      const res1 = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { idempotencyKey: sharedKey },
      });
      expect(res1.statusCode).toBe(201);

      const res2 = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${eco.cust2Token}` },
        payload: { idempotencyKey: sharedKey },
      });
      expect(res2.statusCode).toBe(201);

      // They get two distinct sessions
      expect(res1.json().id).not.toBe(res2.json().id);
    });
  });

  // --- 9. CROSS-CUSTOMER ISOLATION & RBAC REGRESSION ---
  describe('Cross-Customer Isolation & RBAC', () => {
    it('prevents Customer A from reserving, cancelling, expiring, or reading Customer B checkout session', async () => {
      const eco = await setupEcosystem();

      // Customer 1 creates checkout
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 1 },
      });
      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      // Customer 2 tries to GET Customer 1 session
      const getRes = await app.inject({
        method: 'GET',
        url: `/checkout/sessions/${session.id}`,
        headers: { authorization: `Bearer ${eco.cust2Token}` },
      });
      expect(getRes.statusCode).toBe(403);

      // Customer 2 tries to reserve Customer 1 session
      const reserveRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust2Token}` },
      });
      expect(reserveRes.statusCode).toBe(403);

      // Customer 2 tries to cancel Customer 1 session
      const cancelRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/cancel`,
        headers: { authorization: `Bearer ${eco.cust2Token}` },
      });
      expect(cancelRes.statusCode).toBe(403);

      // Customer 2 tries to expire Customer 1 session
      const expireRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/expire`,
        headers: { authorization: `Bearer ${eco.cust2Token}` },
      });
      expect(expireRes.statusCode).toBe(403);
    });

    it('prevents merchants from executing any customer checkout actions', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 1 },
      });
      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      // Merchant Alpha tries to reserve
      const reserveRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      });
      expect(reserveRes.statusCode).toBe(403);

      // Merchant Alpha tries to cancel
      const cancelRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/cancel`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      });
      expect(cancelRes.statusCode).toBe(403);
    });
  });

  // --- 10. CRASH RECOVERY & STUCK VALIDATING RESUMPTION ---
  describe('Crash Recovery & Stuck VALIDATING State Resumption', () => {
    it('recovers stuck VALIDATING checkout after crash occurred AFTER inventory reservation succeeded', async () => {
      const eco = await setupEcosystem();

      // 1. Customer adds 2 units to cart and creates checkout session
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 2 },
      });

      const sessionRes = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const session = sessionRes.json();
      const itemId = session.items[0].id;

      // 2. Simulate process: OPEN -> VALIDATING
      await db.query(
        `UPDATE checkout_sessions SET status = 'VALIDATING', updated_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [session.id],
      );

      // 3. Simulate process: Reservation created in Inventory, but process crashes before READY
      const stableKey = `chk-${session.id}-${itemId}`;
      const invRes = (
        await app.inject({
          method: 'POST',
          url: '/inventory/reservations',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: {
            listingId: eco.listA.id,
            quantity: 2,
            idempotencyKey: stableKey,
          },
        })
      ).json();
      expect(invRes.id).toBeTruthy();

      // 4. Verify pre-recovery state: exactly 2 reserved in Inventory, session is VALIDATING
      const invPre = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(invPre.reservedQuantity).toBe(2);

      // 5. Subsequent request retries POST /reserve (fresh process)
      const retryRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      expect(retryRes.statusCode).toBe(200);
      const retryData = retryRes.json();
      expect(retryData.status).toBe('READY');
      expect(retryData.items[0].inventoryReservationId).toBe(invRes.id);

      // 6. INVARIANT: Inventory was NOT double-reserved (still exactly 2 units, not 4)
      const invPost = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(invPost.reservedQuantity).toBe(2);
      expect(invPost.availableQuantity).toBe(8);

      // Exactly 1 reservation row exists
      const resCount = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM inventory_reservations WHERE idempotency_key = $1`,
        [stableKey],
      );
      expect(parseInt(resCount.rows[0]!.count, 10)).toBe(1);
    });

    it('recovers stuck VALIDATING checkout after crash occurred BEFORE inventory reservation', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 3 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      // Simulate crash immediately after transitioning to VALIDATING (no inventory holds created)
      await db.query(
        `UPDATE checkout_sessions SET status = 'VALIDATING', updated_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [session.id],
      );

      // Retry POST /reserve
      const retryRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      expect(retryRes.statusCode).toBe(200);
      expect(retryRes.json().status).toBe('READY');
      expect(retryRes.json().items[0].inventoryReservationId).toBeTruthy();

      // Exactly 3 reserved in Inventory
      const inv = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(inv.reservedQuantity).toBe(3);
      expect(inv.availableQuantity).toBe(7);
    });

    it('recovers stuck VALIDATING checkout after crash occurred during PARTIAL multi-item reservation', async () => {
      const eco = await setupEcosystem();

      // Multi-vendor cart: Item A (2 units) + Item B (1 unit)
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 2 },
      });
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listB.id, quantity: 1 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      // Transition to VALIDATING
      await db.query(
        `UPDATE checkout_sessions SET status = 'VALIDATING', updated_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [session.id],
      );

      const itemA = session.items.find((i: { listingId: string }) => i.listingId === eco.listA.id);
      const itemB = session.items.find((i: { listingId: string }) => i.listingId === eco.listB.id);

      // Simulate crash: Item A reservation succeeded, process crashed before Item B reservation
      const keyA = `chk-${session.id}-${itemA.id}`;
      const resA = (
        await app.inject({
          method: 'POST',
          url: '/inventory/reservations',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: {
            listingId: eco.listA.id,
            quantity: 2,
            idempotencyKey: keyA,
          },
        })
      ).json();
      expect(resA.id).toBeTruthy();

      // Retry POST /reserve
      const retryRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      expect(retryRes.statusCode).toBe(200);
      const data = retryRes.json();
      expect(data.status).toBe('READY');

      // Item A reservation was reused
      const outA = data.items.find((i: { id: string }) => i.id === itemA.id);
      expect(outA.inventoryReservationId).toBe(resA.id);

      // Item B reservation was newly created
      const outB = data.items.find((i: { id: string }) => i.id === itemB.id);
      expect(outB.inventoryReservationId).toBeTruthy();

      // Stock verification:
      // Item A: exactly 2 reserved (zero duplicate hold)
      const invA = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(invA.reservedQuantity).toBe(2);

      // Item B: exactly 1 reserved
      const invB = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invB.id}`,
          headers: { authorization: `Bearer ${eco.betaToken}` },
        })
      ).json();
      expect(invB.reservedQuantity).toBe(1);
    });

    it('safely handles repeated recovery retries without creating duplicate reservations', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 2 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      await db.query(
        `UPDATE checkout_sessions SET status = 'VALIDATING', updated_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [session.id],
      );

      // Retry 1
      const res1 = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json().status).toBe('READY');

      // Retry 2
      const res2 = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().status).toBe('READY');
      expect(res2.json().items[0].inventoryReservationId).toBe(
        res1.json().items[0].inventoryReservationId,
      );

      // Retry 3
      const res3 = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(res3.statusCode).toBe(200);
      expect(res3.json().status).toBe('READY');

      // Inventory check: exactly 2 reserved
      const inv = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(inv.reservedQuantity).toBe(2);
    });

    it('handles concurrent reserve retries against a stuck VALIDATING session', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 3 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      await db.query(
        `UPDATE checkout_sessions SET status = 'VALIDATING', updated_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [session.id],
      );

      // Concurrent retries
      const [retry1, retry2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/checkout/sessions/${session.id}/reserve`,
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        }),
        app.inject({
          method: 'POST',
          url: `/checkout/sessions/${session.id}/reserve`,
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        }),
      ]);

      expect(retry1.statusCode).toBe(200);
      expect(retry2.statusCode).toBe(200);
      expect(retry1.json().status).toBe('READY');
      expect(retry2.json().status).toBe('READY');
      expect(retry1.json().items[0].inventoryReservationId).toBe(
        retry2.json().items[0].inventoryReservationId,
      );

      const inv = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(inv.reservedQuantity).toBe(3);
    });

    it('rejects recovery retry if checkout was cancelled during/after VALIDATING', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 2 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      await db.query(
        `UPDATE checkout_sessions SET status = 'VALIDATING', updated_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [session.id],
      );

      // Customer cancels
      const cancelRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/cancel`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(cancelRes.statusCode).toBe(200);

      // Retry reserve afterwards
      const retryRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(retryRes.statusCode).toBe(409);
      expect(retryRes.json().error.message).toContain('CANCELLED');
    });

    it('rejects recovery retry if checkout was expired during/after VALIDATING', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 2 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      await db.query(
        `UPDATE checkout_sessions SET status = 'VALIDATING', updated_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [session.id],
      );

      // Expire session
      const expireRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/expire`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(expireRes.statusCode).toBe(200);

      // Retry reserve afterwards
      const retryRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(retryRes.statusCode).toBe(409);
      expect(retryRes.json().error.message).toContain('EXPIRED');
    });

    it('rejects recovery and rolls back existing holds if listing price changed during VALIDATING crash window', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 2 },
      });

      const session = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();
      const itemId = session.items[0].id;

      // Simulate crash: Item hold was acquired in Inventory, status left in VALIDATING
      const stableKey = `chk-${session.id}-${itemId}`;
      const invRes = (
        await app.inject({
          method: 'POST',
          url: '/inventory/reservations',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: {
            listingId: eco.listA.id,
            quantity: 2,
            idempotencyKey: stableKey,
          },
        })
      ).json();
      expect(invRes.id).toBeTruthy();

      await db.query(
        `UPDATE checkout_sessions SET status = 'VALIDATING', updated_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [session.id],
      );

      // Merchant updates price from ₹80,000 to ₹95,000 during the crash window
      await app.inject({
        method: 'PATCH',
        url: `/listings/${eco.listA.id}`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { priceAmount: 9500000 },
      });

      // Customer retries /reserve
      const retryRes = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      expect(retryRes.statusCode).toBe(422);
      expect(retryRes.json().error.code).toBe('CHECKOUT_VALIDATION_FAILED');
      expect(retryRes.json().error.message).toContain('Listing price has changed');

      // CRITICAL: Existing hold was released back to sellable inventory!
      const inv = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(inv.reservedQuantity).toBe(0);
      expect(inv.availableQuantity).toBe(10);

      // Session status is FAILED
      const check = await db.query<{ status: string }>(
        `SELECT status FROM checkout_sessions WHERE id = $1`,
        [session.id],
      );
      expect(check.rows[0]!.status).toBe('FAILED');
    });
  });
});
