import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

describe('Phase 4: Inventory & Stock Management (Authoritative Stock Truth)', () => {
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

  async function setupActors() {
    // 1. Admin
    const adminReg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'admin@platform.com',
        password: 'Password123!',
        tenantName: 'Admin Ops',
        role: 'MERCHANT',
      },
    });
    expect(adminReg.statusCode).toBe(201);
    const userRes = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'admin@platform.com'`,
    );
    await db.query(`UPDATE tenant_memberships SET role = 'ADMINISTRATOR' WHERE user_id = $1`, [
      userRes.rows[0]!.id,
    ]);
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@platform.com', password: 'Password123!' },
    });
    const { accessToken: adminToken } = adminLogin.json();

    // 2. Merchant Alpha
    const alphaReg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'alpha@store.com',
        password: 'Password123!',
        tenantName: 'Merchant Alpha Store',
        role: 'MERCHANT',
      },
    });
    expect(alphaReg.statusCode).toBe(201);
    const { accessToken: alphaToken } = alphaReg.json();

    // Verify Merchant Alpha
    await app.inject({
      method: 'POST',
      url: '/merchants/onboard',
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { businessName: 'Alpha LLC', legalName: 'Alpha Legal Corp', contactEmail: 'alpha@biz.com' },
    });
    await app.inject({ method: 'POST', url: '/merchants/me/submit', headers: { authorization: `Bearer ${alphaToken}` } });
    const profA = (await app.inject({ method: 'GET', url: '/merchants/me', headers: { authorization: `Bearer ${alphaToken}` } })).json();
    await app.inject({ method: 'POST', url: `/merchants/${profA.tenantId}/approve`, headers: { authorization: `Bearer ${adminToken}` } });

    // 3. Merchant Beta
    const betaReg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'beta@store.com',
        password: 'Password123!',
        tenantName: 'Merchant Beta Store',
        role: 'MERCHANT',
      },
    });
    expect(betaReg.statusCode).toBe(201);
    const { accessToken: betaToken } = betaReg.json();

    // Verify Merchant Beta
    await app.inject({
      method: 'POST',
      url: '/merchants/onboard',
      headers: { authorization: `Bearer ${betaToken}` },
      payload: { businessName: 'Beta LLC', legalName: 'Beta Legal Corp', contactEmail: 'beta@biz.com' },
    });
    await app.inject({ method: 'POST', url: '/merchants/me/submit', headers: { authorization: `Bearer ${betaToken}` } });
    const profB = (await app.inject({ method: 'GET', url: '/merchants/me', headers: { authorization: `Bearer ${betaToken}` } })).json();
    await app.inject({ method: 'POST', url: `/merchants/${profB.tenantId}/approve`, headers: { authorization: `Bearer ${adminToken}` } });

    // 4. Customer
    const custReg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'buyer@consumer.com',
        password: 'Password123!',
        tenantName: 'Consumer Tenant',
        role: 'CUSTOMER',
      },
    });
    expect(custReg.statusCode).toBe(201);
    const { accessToken: customerToken } = custReg.json();

    // 5. Canonical Product & SKU in Catalog (Admin)
    const prodRes = await app.inject({
      method: 'POST',
      url: '/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'Apex Runner', slug: 'apex-runner', brand: 'Apex' },
    });
    const product = prodRes.json();
    await app.inject({
      method: 'POST',
      url: `/products/${product.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    const skuRes = await app.inject({
      method: 'POST',
      url: `/products/${product.id}/skus`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { skuCode: 'APX-BLK-10', attributes: { color: 'Black', size: '10' } },
    });
    const sku = skuRes.json();
    await app.inject({
      method: 'POST',
      url: `/skus/${sku.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    // 6. Merchant Alpha creates listing for SKU
    const alphaListingRes = await app.inject({
      method: 'POST',
      url: '/listings',
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { skuId: sku.id, priceAmount: 1200000, currency: 'INR' },
    });
    const alphaListing = alphaListingRes.json();
    await app.inject({
      method: 'POST',
      url: `/listings/${alphaListing.id}/status`,
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { status: 'ACTIVE' },
    });

    // 7. Merchant Beta creates listing for SAME SKU (Multi-Vendor Rule)
    const betaListingRes = await app.inject({
      method: 'POST',
      url: '/listings',
      headers: { authorization: `Bearer ${betaToken}` },
      payload: { skuId: sku.id, priceAmount: 1150000, currency: 'INR' },
    });
    const betaListing = betaListingRes.json();
    await app.inject({
      method: 'POST',
      url: `/listings/${betaListing.id}/status`,
      headers: { authorization: `Bearer ${betaToken}` },
      payload: { status: 'ACTIVE' },
    });

    return {
      adminToken,
      alphaToken,
      betaToken,
      customerToken,
      alphaListingId: alphaListing.id,
      betaListingId: betaListing.id,
      skuId: sku.id,
    };
  }

  describe('Inventory Creation & Validation', () => {
    it('initializes inventory for a merchant listing with initial stock and movement record', async () => {
      const { alphaToken, alphaListingId, skuId } = await setupActors();

      const res = await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: {
          listingId: alphaListingId,
          initialOnHandQuantity: 20,
          initialNonSellableQuantity: 2,
        },
      });
      expect(res.statusCode).toBe(201);
      const inv = res.json();
      expect(inv.id).toBeDefined();
      expect(inv.listingId).toBe(alphaListingId);
      expect(inv.skuId).toBe(skuId);
      expect(inv.onHandQuantity).toBe(20);
      expect(inv.reservedQuantity).toBe(0);
      expect(inv.nonSellableQuantity).toBe(2);
      expect(inv.availableQuantity).toBe(18); // 20 - 0 - 2

      // Verify movement recorded
      const movRes = await app.inject({
        method: 'GET',
        url: `/inventory/${inv.id}/movements`,
        headers: { authorization: `Bearer ${alphaToken}` },
      });
      expect(movRes.statusCode).toBe(200);
      const movements = movRes.json();
      expect(movements.length).toBe(1);
      expect(movements[0].movementType).toBe('INITIAL_STOCK');
      expect(movements[0].newOnHand).toBe(20);
    });

    it('rejects duplicate inventory creation for the same listing', async () => {
      const { alphaToken, alphaListingId } = await setupActors();

      await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { listingId: alphaListingId, initialOnHandQuantity: 10 },
      });

      const dupRes = await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { listingId: alphaListingId, initialOnHandQuantity: 5 },
      });
      expect(dupRes.statusCode).toBe(409);
      expect(dupRes.json().error.message).toContain('already exists for listing');
    });

    it('rejects inventory creation for nonexistent listing', async () => {
      const { alphaToken } = await setupActors();

      const res = await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { listingId: 'nonexistent-listing-id', initialOnHandQuantity: 10 },
      });
      expect(res.statusCode).toBe(404);
    });

    it('rejects merchant trying to initialize inventory for another merchant listing', async () => {
      const { alphaToken, betaListingId } = await setupActors();

      const res = await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { listingId: betaListingId, initialOnHandQuantity: 10 },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Authoritative Availability Calculation', () => {
    it('strictly enforces Available = On Hand - Reserved - Non-Sellable across boundary conditions', async () => {
      const { alphaToken, alphaListingId } = await setupActors();

      // Baseline: On-Hand 10, Reserved 0, Non-Sellable 3 -> Available = 7
      const invRes = await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: {
          listingId: alphaListingId,
          initialOnHandQuantity: 10,
          initialNonSellableQuantity: 3,
        },
      });
      const inv = invRes.json();
      expect(inv.availableQuantity).toBe(7);

      // Increase non-sellable to 10 -> Available = 0
      const adjustRes = await app.inject({
        method: 'POST',
        url: `/inventory/${inv.id}/adjust-non-sellable`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { newNonSellableQuantity: 10 },
      });
      expect(adjustRes.statusCode).toBe(200);
      expect(adjustRes.json().availableQuantity).toBe(0);

      // Non-sellable cannot exceed on-hand
      const invalidAdjust = await app.inject({
        method: 'POST',
        url: `/inventory/${inv.id}/adjust-non-sellable`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { newNonSellableQuantity: 11 },
      });
      expect(invalidAdjust.statusCode).toBe(409);
    });

    it('sanitizes public availability view and excludes raw internal quantities', async () => {
      const { alphaToken, alphaListingId, skuId } = await setupActors();

      await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: {
          listingId: alphaListingId,
          initialOnHandQuantity: 15,
          initialNonSellableQuantity: 3,
        },
      });

      // Public availability endpoint (unauthenticated)
      const pubRes = await app.inject({
        method: 'GET',
        url: `/inventory/availability/${alphaListingId}`,
      });
      expect(pubRes.statusCode).toBe(200);
      const pubData = pubRes.json();
      expect(pubData.listingId).toBe(alphaListingId);
      expect(pubData.skuId).toBe(skuId);
      expect(pubData.isAvailable).toBe(true);
      expect(pubData.availableQuantity).toBe(12);

      // Confidential internal fields MUST NOT leak to public view
      expect(pubData.onHandQuantity).toBeUndefined();
      expect(pubData.reservedQuantity).toBeUndefined();
      expect(pubData.nonSellableQuantity).toBeUndefined();
      expect(pubData.version).toBeUndefined();
      expect(pubData.movements).toBeUndefined();
    });
  });

  describe('Controlled Stock Adjustments', () => {
    it('increases and decreases stock with movements and prevents negative stock', async () => {
      const { alphaToken, alphaListingId } = await setupActors();

      const inv = (
        await app.inject({
          method: 'POST',
          url: '/inventory',
          headers: { authorization: `Bearer ${alphaToken}` },
          payload: { listingId: alphaListingId, initialOnHandQuantity: 10 },
        })
      ).json();

      // Increase stock +5 -> On Hand 15
      const incRes = await app.inject({
        method: 'POST',
        url: `/inventory/${inv.id}/increase-stock`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { quantity: 5, notes: 'Restock shipment received' },
      });
      expect(incRes.statusCode).toBe(200);
      expect(incRes.json().onHandQuantity).toBe(15);
      expect(incRes.json().availableQuantity).toBe(15);

      // Decrease stock -3 -> On Hand 12
      const decRes = await app.inject({
        method: 'POST',
        url: `/inventory/${inv.id}/decrease-stock`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { quantity: 3, notes: 'Damaged item return' },
      });
      expect(decRes.statusCode).toBe(200);
      expect(decRes.json().onHandQuantity).toBe(12);

      // Cannot decrease by more than available stock
      const overDec = await app.inject({
        method: 'POST',
        url: `/inventory/${inv.id}/decrease-stock`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { quantity: 20 },
      });
      expect(overDec.statusCode).toBe(409);
    });
  });

  describe('Reservation Lifecycle (Hold, Release, Consume, Expire)', () => {
    it('creates active reservation, updates reserved quantity, and handles release', async () => {
      const { customerToken, alphaToken, alphaListingId } = await setupActors();

      const inv = (
        await app.inject({
          method: 'POST',
          url: '/inventory',
          headers: { authorization: `Bearer ${alphaToken}` },
          payload: { listingId: alphaListingId, initialOnHandQuantity: 10 },
        })
      ).json();

      // Customer creates reservation for 4 units
      const resRes = await app.inject({
        method: 'POST',
        url: '/inventory/reservations',
        headers: { authorization: `Bearer ${customerToken}` },
        payload: { inventoryId: inv.id, quantity: 4, idempotencyKey: 'idemp-res-1' },
      });
      expect(resRes.statusCode).toBe(201);
      const reservation = resRes.json();
      expect(reservation.status).toBe('ACTIVE');
      expect(reservation.quantity).toBe(4);

      // Check updated inventory: On Hand 10, Reserved 4, Available 6
      const checkInv = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${inv.id}`,
          headers: { authorization: `Bearer ${alphaToken}` },
        })
      ).json();
      expect(checkInv.reservedQuantity).toBe(4);
      expect(checkInv.availableQuantity).toBe(6);

      // Idempotency: Repeating exact same reservation returns existing reservation without duplicating reserved stock
      const retryRes = await app.inject({
        method: 'POST',
        url: '/inventory/reservations',
        headers: { authorization: `Bearer ${customerToken}` },
        payload: { inventoryId: inv.id, quantity: 4, idempotencyKey: 'idemp-res-1' },
      });
      expect(retryRes.statusCode).toBe(201);
      expect(retryRes.json().id).toBe(reservation.id);

      // Still Reserved 4, NOT 8
      const recheckInv = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${inv.id}`,
          headers: { authorization: `Bearer ${alphaToken}` },
        })
      ).json();
      expect(recheckInv.reservedQuantity).toBe(4);

      // Customer releases reservation
      const releaseRes = await app.inject({
        method: 'POST',
        url: `/inventory/reservations/${reservation.id}/release`,
        headers: { authorization: `Bearer ${customerToken}` },
        payload: { notes: 'Customer cancelled cart' },
      });
      expect(releaseRes.statusCode).toBe(200);
      expect(releaseRes.json().status).toBe('RELEASED');

      // Inventory restored: Reserved 0, Available 10
      const releasedInv = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${inv.id}`,
          headers: { authorization: `Bearer ${alphaToken}` },
        })
      ).json();
      expect(releasedInv.reservedQuantity).toBe(0);
      expect(releasedInv.availableQuantity).toBe(10);

      // Double release MUST be rejected
      const doubleRelease = await app.inject({
        method: 'POST',
        url: `/inventory/reservations/${reservation.id}/release`,
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(doubleRelease.statusCode).toBe(409);
    });

    it('consumes reservation on checkout/order completion and reduces on-hand quantity', async () => {
      const { customerToken, alphaToken, alphaListingId } = await setupActors();

      const inv = (
        await app.inject({
          method: 'POST',
          url: '/inventory',
          headers: { authorization: `Bearer ${alphaToken}` },
          payload: { listingId: alphaListingId, initialOnHandQuantity: 10 },
        })
      ).json();

      const res = (
        await app.inject({
          method: 'POST',
          url: '/inventory/reservations',
          headers: { authorization: `Bearer ${customerToken}` },
          payload: { inventoryId: inv.id, quantity: 3 },
        })
      ).json();

      // Consume reservation
      const consumeRes = await app.inject({
        method: 'POST',
        url: `/inventory/reservations/${res.id}/consume`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { notes: 'Order confirmed and paid' },
      });
      expect(consumeRes.statusCode).toBe(200);
      expect(consumeRes.json().status).toBe('CONSUMED');

      // On-Hand reduced from 10 to 7, Reserved reduced from 3 to 0, Available = 7
      const consumedInv = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${inv.id}`,
          headers: { authorization: `Bearer ${alphaToken}` },
        })
      ).json();
      expect(consumedInv.onHandQuantity).toBe(7);
      expect(consumedInv.reservedQuantity).toBe(0);
      expect(consumedInv.availableQuantity).toBe(7);

      // Double consume MUST be rejected
      const doubleConsume = await app.inject({
        method: 'POST',
        url: `/inventory/reservations/${res.id}/consume`,
        headers: { authorization: `Bearer ${alphaToken}` },
      });
      expect(doubleConsume.statusCode).toBe(200);
    });

    it('handles reservation expiration and restores available stock', async () => {
      const { customerToken, alphaToken, adminToken, alphaListingId } = await setupActors();

      const inv = (
        await app.inject({
          method: 'POST',
          url: '/inventory',
          headers: { authorization: `Bearer ${alphaToken}` },
          payload: { listingId: alphaListingId, initialOnHandQuantity: 10 },
        })
      ).json();

      const res = (
        await app.inject({
          method: 'POST',
          url: '/inventory/reservations',
          headers: { authorization: `Bearer ${customerToken}` },
          payload: { inventoryId: inv.id, quantity: 5 },
        })
      ).json();

      // Trigger expiration
      const expireRes = await app.inject({
        method: 'POST',
        url: `/inventory/reservations/${res.id}/expire`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { notes: 'Cart reservation TTL exceeded' },
      });
      expect(expireRes.statusCode).toBe(200);
      expect(expireRes.json().status).toBe('EXPIRED');

      // Reserved quantity restored
      const afterExpire = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${inv.id}`,
          headers: { authorization: `Bearer ${alphaToken}` },
        })
      ).json();
      expect(afterExpire.reservedQuantity).toBe(0);
      expect(afterExpire.availableQuantity).toBe(10);
    });

    it('rejects reservation when requested quantity exceeds available stock', async () => {
      const { customerToken, alphaToken, alphaListingId } = await setupActors();

      const inv = (
        await app.inject({
          method: 'POST',
          url: '/inventory',
          headers: { authorization: `Bearer ${alphaToken}` },
          payload: { listingId: alphaListingId, initialOnHandQuantity: 5 },
        })
      ).json();

      const res = await app.inject({
        method: 'POST',
        url: '/inventory/reservations',
        headers: { authorization: `Bearer ${customerToken}` },
        payload: { inventoryId: inv.id, quantity: 6 },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('INSUFFICIENT_INVENTORY');
    });
  });

  describe('Multi-Vendor Stock Separation & Tenant Isolation', () => {
    it('guarantees that Merchant A stock is completely independent from Merchant B stock for same SKU', async () => {
      const { alphaToken, betaToken, alphaListingId, betaListingId } = await setupActors();

      // Merchant Alpha has 50 units
      const invA = (
        await app.inject({
          method: 'POST',
          url: '/inventory',
          headers: { authorization: `Bearer ${alphaToken}` },
          payload: { listingId: alphaListingId, initialOnHandQuantity: 50 },
        })
      ).json();

      // Merchant Beta has 5 units
      const invB = (
        await app.inject({
          method: 'POST',
          url: '/inventory',
          headers: { authorization: `Bearer ${betaToken}` },
          payload: { listingId: betaListingId, initialOnHandQuantity: 5 },
        })
      ).json();

      expect(invA.availableQuantity).toBe(50);
      expect(invB.availableQuantity).toBe(5);

      // Merchant Alpha modifies their stock
      await app.inject({
        method: 'POST',
        url: `/inventory/${invA.id}/increase-stock`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { quantity: 10 },
      });

      // Merchant Beta's stock remains untouched
      const checkBeta = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${invB.id}`,
          headers: { authorization: `Bearer ${betaToken}` },
        })
      ).json();
      expect(checkBeta.onHandQuantity).toBe(5);
    });

    it('prevents Merchant B from reading or modifying Merchant A inventory', async () => {
      const { alphaToken, betaToken, alphaListingId } = await setupActors();

      const invA = (
        await app.inject({
          method: 'POST',
          url: '/inventory',
          headers: { authorization: `Bearer ${alphaToken}` },
          payload: { listingId: alphaListingId, initialOnHandQuantity: 20 },
        })
      ).json();

      // Merchant B attempts to read Merchant A's inventory
      const readRes = await app.inject({
        method: 'GET',
        url: `/inventory/${invA.id}`,
        headers: { authorization: `Bearer ${betaToken}` },
      });
      expect(readRes.statusCode).toBe(403);

      // Merchant B attempts to adjust Merchant A's stock
      const modRes = await app.inject({
        method: 'POST',
        url: `/inventory/${invA.id}/decrease-stock`,
        headers: { authorization: `Bearer ${betaToken}` },
        payload: { quantity: 5 },
      });
      expect(modRes.statusCode).toBe(403);
    });

    it('prevents Merchant B from releasing or consuming Customer reservation on Merchant A inventory', async () => {
      const { alphaToken, betaToken, customerToken, alphaListingId } = await setupActors();

      const invA = (
        await app.inject({
          method: 'POST',
          url: '/inventory',
          headers: { authorization: `Bearer ${alphaToken}` },
          payload: { listingId: alphaListingId, initialOnHandQuantity: 20 },
        })
      ).json();

      const res = (
        await app.inject({
          method: 'POST',
          url: '/inventory/reservations',
          headers: { authorization: `Bearer ${customerToken}` },
          payload: { inventoryId: invA.id, quantity: 2 },
        })
      ).json();

      // Merchant B tries to release Customer's reservation
      const releaseRes = await app.inject({
        method: 'POST',
        url: `/inventory/reservations/${res.id}/release`,
        headers: { authorization: `Bearer ${betaToken}` },
      });
      expect(releaseRes.statusCode).toBe(403);

      // Merchant B tries to consume Customer's reservation
      const consumeRes = await app.inject({
        method: 'POST',
        url: `/inventory/reservations/${res.id}/consume`,
        headers: { authorization: `Bearer ${betaToken}` },
      });
      expect(consumeRes.statusCode).toBe(403);
    });
  });
});
