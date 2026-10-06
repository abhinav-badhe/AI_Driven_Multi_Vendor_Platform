import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase, markAllUsersVerified, registerVerifiedUser } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

describe('Phase 4: Concurrency & Overselling Prevention', () => {
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

  async function setupInventoryBaseline(onHand = 10) {
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
      tenantName: 'Concurrency Merchant Store',
      role: 'MERCHANT',
    });

    await app.inject({
      method: 'POST',
      url: '/merchants/onboard',
      headers: { authorization: `Bearer ${merchantToken}` },
      payload: { businessName: 'Conc LLC', legalName: 'Conc Legal', contactEmail: 'c@c.com' },
    });
    await app.inject({ method: 'POST', url: '/merchants/me/submit', headers: { authorization: `Bearer ${merchantToken}` } });
    const prof = (await app.inject({ method: 'GET', url: '/merchants/me', headers: { authorization: `Bearer ${merchantToken}` } })).json();
    await app.inject({ method: 'POST', url: `/merchants/${prof.tenantId}/approve`, headers: { authorization: `Bearer ${adminToken}` } });

    // 3. Customer setup
    const customer1Token = await registerVerifiedUser(app, db, {
      email: 'cust1@c.com',
      password: 'Password123!',
      tenantName: 'Cust 1',
      role: 'CUSTOMER',
    });

    const customer2Token = await registerVerifiedUser(app, db, {
      email: 'cust2@c.com',
      password: 'Password123!',
      tenantName: 'Cust 2',
      role: 'CUSTOMER',
    });

    // 4. Product, SKU & Listing
    const prod = (
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'Limited Edition Sneaker', slug: 'ltd-sneaker' },
      })
    ).json();
    await app.inject({ method: 'POST', url: `/products/${prod.id}/status`, headers: { authorization: `Bearer ${adminToken}` }, payload: { status: 'ACTIVE' } });

    const sku = (
      await app.inject({
        method: 'POST',
        url: `/products/${prod.id}/skus`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { skuCode: 'LTD-SNK-01' },
      })
    ).json();
    await app.inject({ method: 'POST', url: `/skus/${sku.id}/status`, headers: { authorization: `Bearer ${adminToken}` }, payload: { status: 'ACTIVE' } });

    const listing = (
      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${merchantToken}` },
        payload: { skuId: sku.id, priceAmount: 1999900, currency: 'INR' },
      })
    ).json();
    await app.inject({ method: 'POST', url: `/listings/${listing.id}/status`, headers: { authorization: `Bearer ${merchantToken}` }, payload: { status: 'ACTIVE' } });

    // 5. Initialize Inventory
    const inv = (
      await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${merchantToken}` },
        payload: { listingId: listing.id, initialOnHandQuantity: onHand },
      })
    ).json();

    return {
      adminToken,
      merchantToken,
      customer1Token,
      customer2Token,
      inventoryId: inv.id,
      listingId: listing.id,
    };
  }

  it('guarantees that 2 concurrent reservations of 7 units against 10 stock results in exactly 1 success and 0 overselling', async () => {
    const { customer1Token, customer2Token, inventoryId } = await setupInventoryBaseline(10);

    // Two concurrent requests attempt to reserve 7 units simultaneously
    const reqA = app.inject({
      method: 'POST',
      url: '/inventory/reservations',
      headers: { authorization: `Bearer ${customer1Token}` },
      payload: { inventoryId, quantity: 7 },
    });

    const reqB = app.inject({
      method: 'POST',
      url: '/inventory/reservations',
      headers: { authorization: `Bearer ${customer2Token}` },
      payload: { inventoryId, quantity: 7 },
    });

    const [resA, resB] = await Promise.all([reqA, reqB]);

    // Exactly one reservation must succeed (201) and the other must be rejected (409)
    const successCount = [resA, resB].filter((r) => r.statusCode === 201).length;
    const conflictCount = [resA, resB].filter((r) => r.statusCode === 409).length;

    expect(successCount).toBe(1);
    expect(conflictCount).toBe(1);

    // Verify rejection details
    const failedRes = resA.statusCode === 409 ? resA : resB;
    expect(failedRes.json().error.code).toBe('INSUFFICIENT_INVENTORY');

    // Authoritative Database Invariant Check:
    // On-Hand = 10, Reserved MUST BE 7 (NOT 14!), Available MUST BE 3 (NOT negative!)
    const invRows = await db.query<{
      on_hand_quantity: number;
      reserved_quantity: number;
      non_sellable_quantity: number;
    }>(`SELECT on_hand_quantity, reserved_quantity, non_sellable_quantity FROM inventory_items WHERE id = $1`, [
      inventoryId,
    ]);
    const inv = invRows.rows[0]!;
    expect(inv.on_hand_quantity).toBe(10);
    expect(inv.reserved_quantity).toBe(7);
    expect(inv.on_hand_quantity - inv.reserved_quantity - inv.non_sellable_quantity).toBe(3);
  });

  it('handles competitive concurrent reservation storm: 10 parallel requests of 2 units against 10 units stock', async () => {
    const { customer1Token, inventoryId } = await setupInventoryBaseline(10);

    // 10 concurrent requests of 2 units = 20 units total demand against 10 units stock
    const requests = Array.from({ length: 10 }, (_, i) =>
      app.inject({
        method: 'POST',
        url: '/inventory/reservations',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { inventoryId, quantity: 2, idempotencyKey: `storm-req-${i}` },
      }),
    );

    const responses = await Promise.all(requests);

    const successful = responses.filter((r) => r.statusCode === 201);
    const rejected = responses.filter((r) => r.statusCode === 409);

    // Exactly 5 requests succeed (5 x 2 = 10 units), and 5 are rejected
    expect(successful.length).toBe(5);
    expect(rejected.length).toBe(5);

    // Database state must be exactly 10 reserved, 0 available, 0 non-sellable
    const invRows = await db.query<{
      on_hand_quantity: number;
      reserved_quantity: number;
      non_sellable_quantity: number;
    }>(`SELECT on_hand_quantity, reserved_quantity, non_sellable_quantity FROM inventory_items WHERE id = $1`, [
      inventoryId,
    ]);
    const inv = invRows.rows[0]!;
    expect(inv.on_hand_quantity).toBe(10);
    expect(inv.reserved_quantity).toBe(10);
    expect(inv.on_hand_quantity - inv.reserved_quantity - inv.non_sellable_quantity).toBe(0);
  });

  describe('Phase 4: Inventory Expiration Background Worker', () => {
    it('1. automatically discovers and expires ACTIVE reservations past their expires_at, releasing stock exactly once', async () => {
      const { customer1Token, adminToken, inventoryId } = await setupInventoryBaseline(10);

      // Create an already expired reservation
      const res = await app.inject({
        method: 'POST',
        url: '/inventory/reservations',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { inventoryId, quantity: 3, expiresAt: new Date(Date.now() - 10000).toISOString() },
      });
      const reservationId = res.json().id;

      let inv = (await db.query<{ reserved_quantity: number }>(`SELECT reserved_quantity FROM inventory_items WHERE id = $1`, [inventoryId])).rows[0]!;
      expect(inv.reserved_quantity).toBe(3);

      // Trigger the expiration worker
      const processRes = await app.inject({
        method: 'POST',
        url: '/inventory/reservations/process-expirations',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      if (processRes.statusCode !== 200) console.log('ERROR:', processRes.json());
      expect(processRes.statusCode).toBe(200);
      expect(processRes.json().processedCount).toBe(1);

      // Verify state transition to EXPIRED
      const updatedRes = (await app.inject({
        method: 'GET',
        url: `/inventory/reservations/${reservationId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      })).json();
      expect(updatedRes.status).toBe('EXPIRED');

      // Verify stock released exactly once
      inv = (await db.query<{ reserved_quantity: number }>(`SELECT reserved_quantity FROM inventory_items WHERE id = $1`, [inventoryId])).rows[0]!;
      expect(inv.reserved_quantity).toBe(0);
    });

    it('2. does not expire ACTIVE reservations if expires_at is in the future', async () => {
      const { customer1Token, adminToken, inventoryId } = await setupInventoryBaseline(10);

      await app.inject({
        method: 'POST',
        url: '/inventory/reservations',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { inventoryId, quantity: 4, expiresAt: new Date(Date.now() + 10000).toISOString() },
      });

      const processRes = await app.inject({
        method: 'POST',
        url: '/inventory/reservations/process-expirations',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(processRes.json().processedCount).toBe(0);

      const inv = (await db.query<{ reserved_quantity: number }>(`SELECT reserved_quantity FROM inventory_items WHERE id = $1`, [inventoryId])).rows[0]!;
      expect(inv.reserved_quantity).toBe(4);
    });

    it('3. idempotency: already EXPIRED, RELEASED, or CONSUMED reservations are safe to retry and do not release stock again', async () => {
      const { customer1Token, adminToken, inventoryId } = await setupInventoryBaseline(10);

      // Create expired reservation
      const res = await app.inject({
        method: 'POST',
        url: '/inventory/reservations',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { inventoryId, quantity: 2, expiresAt: new Date(Date.now() - 10000).toISOString() },
      });
      const reservationId = res.json().id;

      // First run expires it
      await app.inject({ method: 'POST', url: '/inventory/reservations/process-expirations', headers: { authorization: `Bearer ${adminToken}` } });
      
      // Explicit retry via manual API
      const retryRes = await app.inject({
        method: 'POST',
        url: `/inventory/reservations/${reservationId}/expire`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(retryRes.statusCode).toBe(200);

      // Reserved quantity should be 0 (not negative)
      const inv = (await db.query<{ reserved_quantity: number }>(`SELECT reserved_quantity FROM inventory_items WHERE id = $1`, [inventoryId])).rows[0]!;
      expect(inv.reserved_quantity).toBe(0);
    });

    it('4. concurrency: two parallel expiration workers process without deadlocking or double-releasing', async () => {
      const { customer1Token, adminToken, inventoryId } = await setupInventoryBaseline(10);

      await app.inject({
        method: 'POST',
        url: '/inventory/reservations',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { inventoryId, quantity: 2, expiresAt: new Date(Date.now() - 10000).toISOString() },
      });

      // Launch 5 concurrent workers
      const requests = Array.from({ length: 5 }, () =>
        app.inject({
          method: 'POST',
          url: '/inventory/reservations/process-expirations',
          headers: { authorization: `Bearer ${adminToken}` },
        })
      );
      const responses = await Promise.all(requests);
      
      const totalProcessed = responses.reduce((sum, r) => sum + r.json().processedCount, 0);
      expect(totalProcessed).toBe(1); // Only 1 worker should claim and process it

      const inv = (await db.query<{ reserved_quantity: number }>(`SELECT reserved_quantity FROM inventory_items WHERE id = $1`, [inventoryId])).rows[0]!;
      expect(inv.reserved_quantity).toBe(0);
    });

    it('5. race condition: expiration racing with consume guarantees exactly one wins', async () => {
      const { customer1Token, merchantToken, adminToken, inventoryId } = await setupInventoryBaseline(10);

      const res = await app.inject({
        method: 'POST',
        url: '/inventory/reservations',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { inventoryId, quantity: 5, expiresAt: new Date(Date.now() - 10000).toISOString() },
      });
      const resId = res.json().id;

      // Concurrently run process-expirations and consume
      const [expireResult, consumeResult] = await Promise.all([
        app.inject({ method: 'POST', url: '/inventory/reservations/process-expirations', headers: { authorization: `Bearer ${adminToken}` } }),
        app.inject({ method: 'POST', url: `/inventory/reservations/${resId}/consume`, headers: { authorization: `Bearer ${merchantToken}` } })
      ]);
      expect(expireResult.statusCode).toBe(200);

      const reservation = (await app.inject({
        method: 'GET',
        url: `/inventory/reservations/${resId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      })).json();

      const inv = (await db.query<{ reserved_quantity: number, on_hand_quantity: number }>(`SELECT reserved_quantity, on_hand_quantity FROM inventory_items WHERE id = $1`, [inventoryId])).rows[0]!;
      
      expect(inv.reserved_quantity).toBe(0);
      
      if (reservation.status === 'CONSUMED') {
        expect(inv.on_hand_quantity).toBe(5); // Deducted
        expect(consumeResult.statusCode).toBe(200);
      } else {
        expect(reservation.status).toBe('EXPIRED');
        expect(inv.on_hand_quantity).toBe(10); // Not deducted
      }
    });

    it('6. batching: correctly processes multiple expired reservations', async () => {
      const { customer1Token, adminToken, inventoryId } = await setupInventoryBaseline(10);

      // Create 3 expired reservations of 2 quantity each (total 6 reserved)
      for(let i=0; i<3; i++) {
        await app.inject({
          method: 'POST',
          url: '/inventory/reservations',
          headers: { authorization: `Bearer ${customer1Token}` },
          payload: { inventoryId, quantity: 2, expiresAt: new Date(Date.now() - 10000).toISOString() },
        });
      }

      let inv = (await db.query<{ reserved_quantity: number }>(`SELECT reserved_quantity FROM inventory_items WHERE id = $1`, [inventoryId])).rows[0]!;
      expect(inv.reserved_quantity).toBe(6);

      const processRes = await app.inject({
        method: 'POST',
        url: '/inventory/reservations/process-expirations',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(processRes.json().processedCount).toBe(3);

      inv = (await db.query<{ reserved_quantity: number }>(`SELECT reserved_quantity FROM inventory_items WHERE id = $1`, [inventoryId])).rows[0]!;
      expect(inv.reserved_quantity).toBe(0);
    });
  });
});
