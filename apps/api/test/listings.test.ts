import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

describe('Phase 3: Marketplace Listings (Multi-Vendor, Lifecycle & Tenant Isolation)', () => {
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
        tenantName: 'Platform Admin Tenant',
        role: 'MERCHANT',
      },
    });
    expect(adminReg.statusCode).toBe(201);
    const userRes = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'admin@platform.com'`,
    );
    const adminUserId = userRes.rows[0]!.id;
    await db.query(`UPDATE tenant_memberships SET role = 'ADMINISTRATOR' WHERE user_id = $1`, [
      adminUserId,
    ]);
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@platform.com', password: 'Password123!' },
    });
    const { accessToken: adminToken } = adminLogin.json();

    // 2. Merchant Alpha
    const mAlphaReg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'alpha@store.com',
        password: 'Password123!',
        tenantName: 'Merchant Alpha Store',
        role: 'MERCHANT',
      },
    });
    const { accessToken: alphaToken } = mAlphaReg.json();

    // 3. Merchant Beta
    const mBetaReg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'beta@store.com',
        password: 'Password123!',
        tenantName: 'Merchant Beta Store',
        role: 'MERCHANT',
      },
    });
    const { accessToken: betaToken } = mBetaReg.json();

    // 4. Customer
    const custReg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'buyer@consumer.com',
        password: 'Password123!',
        tenantName: 'Buyer Tenant',
        role: 'CUSTOMER',
      },
    });
    const { accessToken: customerToken } = custReg.json();

    // 5. Canonical Product & SKU in Catalog (created by Admin)
    const prodRes = await app.inject({
      method: 'POST',
      url: '/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'Pro Running Shoes', slug: 'pro-running-shoes', brand: 'FastTrack' },
    });
    const product = prodRes.json();

    // Activate Product
    await app.inject({
      method: 'POST',
      url: `/products/${product.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    // Create SKU
    const skuRes = await app.inject({
      method: 'POST',
      url: `/products/${product.id}/skus`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        skuCode: 'PRS-BLK-09',
        attributes: { color: 'Black', size: '9' },
      },
    });
    const sku = skuRes.json();

    return {
      adminToken,
      alphaToken,
      betaToken,
      customerToken,
      productId: product.id,
      skuId: sku.id,
    };
  }

  describe('Multi-Vendor Core Rule & Listing Creation', () => {
    it('allows multiple merchants to create independent listings for the exact same canonical SKU', async () => {
      const { alphaToken, betaToken, skuId } = await setupActors();

      // Merchant Alpha creates listing for SKU at ₹8,999 (899900 minor units)
      const alphaListingRes = await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: {
          skuId,
          priceAmount: 899900,
          currency: 'INR',
          compareAtPrice: 999900,
        },
      });
      expect(alphaListingRes.statusCode).toBe(201);
      const alphaListing = alphaListingRes.json();
      expect(alphaListing.skuId).toBe(skuId);
      expect(alphaListing.priceAmount).toBe(899900);
      expect(alphaListing.currency).toBe('INR');
      expect(alphaListing.status).toBe('DRAFT');

      // Merchant Beta creates listing for SAME SKU at ₹9,499 (949900 minor units)
      const betaListingRes = await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${betaToken}` },
        payload: {
          skuId,
          priceAmount: 949900,
          currency: 'INR',
        },
      });
      expect(betaListingRes.statusCode).toBe(201);
      const betaListing = betaListingRes.json();
      expect(betaListing.skuId).toBe(skuId);
      expect(betaListing.priceAmount).toBe(949900);
      expect(betaListing.tenantId).not.toBe(alphaListing.tenantId);
    });

    it('rejects duplicate listings by the same merchant for the same SKU', async () => {
      const { alphaToken, skuId } = await setupActors();

      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { skuId, priceAmount: 500000, currency: 'INR' },
      });

      // Second attempt by same merchant for same SKU
      const dupRes = await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { skuId, priceAmount: 480000, currency: 'INR' },
      });
      expect(dupRes.statusCode).toBe(409);
      expect(dupRes.json().error.message).toContain('already has a listing for SKU');
    });

    it('validates price and currency invariants on creation', async () => {
      const { alphaToken, skuId } = await setupActors();

      // Negative price
      const negPrice = await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { skuId, priceAmount: -100, currency: 'INR' },
      });
      expect(negPrice.statusCode).toBe(400);

      // Non-integer price
      const floatPrice = await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { skuId, priceAmount: 49.99, currency: 'INR' },
      });
      expect(floatPrice.statusCode).toBe(400);

      // Invalid currency
      const badCurrency = await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { skuId, priceAmount: 1000, currency: 'INVALID_CURRENCY' },
      });
      expect(badCurrency.statusCode).toBe(400);
    });

    it('rejects listing for non-existent canonical SKU', async () => {
      const { alphaToken } = await setupActors();

      const res = await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { skuId: '00000000-0000-0000-0000-000000000000', priceAmount: 1000, currency: 'USD' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('Tenant Isolation & Authorization', () => {
    it('prevents a merchant from viewing another merchant draft/inactive listing', async () => {
      const { alphaToken, betaToken, skuId } = await setupActors();

      const alphaListing = (
        await app.inject({
          method: 'POST',
          url: '/listings',
          headers: { authorization: `Bearer ${alphaToken}` },
          payload: { skuId, priceAmount: 700000, currency: 'INR' },
        })
      ).json();

      // Merchant Beta tries to view Merchant Alpha's draft listing
      const res = await app.inject({
        method: 'GET',
        url: `/listings/${alphaListing.id}`,
        headers: { authorization: `Bearer ${betaToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('prevents a merchant from modifying another merchant listing', async () => {
      const { alphaToken, betaToken, skuId } = await setupActors();

      const alphaListing = (
        await app.inject({
          method: 'POST',
          url: '/listings',
          headers: { authorization: `Bearer ${alphaToken}` },
          payload: { skuId, priceAmount: 700000, currency: 'INR' },
        })
      ).json();

      // Merchant Beta tries to update Merchant Alpha's price
      const tamperRes = await app.inject({
        method: 'PATCH',
        url: `/listings/${alphaListing.id}`,
        headers: { authorization: `Bearer ${betaToken}` },
        payload: { priceAmount: 100000 },
      });
      expect(tamperRes.statusCode).toBe(403);
    });

    it('allows merchant to update own listing price', async () => {
      const { alphaToken, skuId } = await setupActors();

      const alphaListing = (
        await app.inject({
          method: 'POST',
          url: '/listings',
          headers: { authorization: `Bearer ${alphaToken}` },
          payload: { skuId, priceAmount: 700000, currency: 'INR' },
        })
      ).json();

      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/listings/${alphaListing.id}`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { priceAmount: 750000, compareAtPrice: 850000 },
      });
      expect(updateRes.statusCode).toBe(200);
      const updated = updateRes.json();
      expect(updated.priceAmount).toBe(750000);
      expect(updated.compareAtPrice).toBe(850000);
    });

    it('allows merchant to view list of their own listings only', async () => {
      const { alphaToken, betaToken, skuId } = await setupActors();

      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { skuId, priceAmount: 500000, currency: 'INR' },
      });

      const myListingsRes = await app.inject({
        method: 'GET',
        url: '/listings/me',
        headers: { authorization: `Bearer ${betaToken}` },
      });
      expect(myListingsRes.statusCode).toBe(200);
      expect(myListingsRes.json().length).toBe(0); // Beta has 0 listings
    });
  });

  describe('Listing Lifecycle State Machine', () => {
    it('rejects activation if canonical SKU is not in ACTIVE status', async () => {
      const { adminToken, alphaToken, productId } = await setupActors();

      // Create a DRAFT SKU (not activated)
      const draftSku = (
        await app.inject({
          method: 'POST',
          url: `/products/${productId}/skus`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { skuCode: 'DRAFT-SKU-99' },
        })
      ).json();

      // Onboard and verify merchant
      await app.inject({
        method: 'POST',
        url: '/merchants/onboard',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: {
          businessName: 'Alpha Biz',
          legalName: 'Alpha Legal',
          contactEmail: 'alpha@biz.com',
        },
      });
      await app.inject({
        method: 'POST',
        url: '/merchants/me/submit',
        headers: { authorization: `Bearer ${alphaToken}` },
      });
      // Get alpha tenantId from profile
      const prof = (
        await app.inject({
          method: 'GET',
          url: '/merchants/me',
          headers: { authorization: `Bearer ${alphaToken}` },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/merchants/${prof.tenantId}/approve`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      // Create listing for draft SKU
      const listing = (
        await app.inject({
          method: 'POST',
          url: '/listings',
          headers: { authorization: `Bearer ${alphaToken}` },
          payload: { skuId: draftSku.id, priceAmount: 100000, currency: 'INR' },
        })
      ).json();

      // Attempt to activate listing -> MUST fail because SKU is DRAFT
      const activateRes = await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/status`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { status: 'ACTIVE' },
      });
      expect(activateRes.statusCode).toBe(409);
      expect(activateRes.json().error.message).toContain('must be ACTIVE');
    });

    it('rejects activation if Merchant is not VERIFIED', async () => {
      const { adminToken, alphaToken, skuId } = await setupActors();

      // Activate canonical SKU
      await app.inject({
        method: 'POST',
        url: `/skus/${skuId}/status`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { status: 'ACTIVE' },
      });

      // Merchant creates listing WITHOUT being verified
      const listing = (
        await app.inject({
          method: 'POST',
          url: '/listings',
          headers: { authorization: `Bearer ${alphaToken}` },
          payload: { skuId, priceAmount: 200000, currency: 'INR' },
        })
      ).json();

      // Attempt to activate listing -> MUST fail because Merchant is unverified
      const activateRes = await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/status`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { status: 'ACTIVE' },
      });
      expect(activateRes.statusCode).toBe(409);
      expect(activateRes.json().error.message).toContain('not VERIFIED');
    });

    it('successfully activates listing once SKU is ACTIVE and Merchant is VERIFIED', async () => {
      const { adminToken, alphaToken, skuId } = await setupActors();

      // 1. Activate SKU
      await app.inject({
        method: 'POST',
        url: `/skus/${skuId}/status`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { status: 'ACTIVE' },
      });

      // 2. Onboard and verify merchant
      await app.inject({
        method: 'POST',
        url: '/merchants/onboard',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: {
          businessName: 'Alpha Certified',
          legalName: 'Alpha Certified Corp',
          contactEmail: 'alpha@certified.com',
        },
      });
      await app.inject({
        method: 'POST',
        url: '/merchants/me/submit',
        headers: { authorization: `Bearer ${alphaToken}` },
      });
      const prof = (
        await app.inject({
          method: 'GET',
          url: '/merchants/me',
          headers: { authorization: `Bearer ${alphaToken}` },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/merchants/${prof.tenantId}/approve`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      // 3. Create listing
      const listing = (
        await app.inject({
          method: 'POST',
          url: '/listings',
          headers: { authorization: `Bearer ${alphaToken}` },
          payload: { skuId, priceAmount: 250000, currency: 'INR' },
        })
      ).json();

      // 4. Activate listing -> SUCCESS
      const activateRes = await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/status`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { status: 'ACTIVE' },
      });
      expect(activateRes.statusCode).toBe(200);
      expect(activateRes.json().status).toBe('ACTIVE');

      // 5. Merchant can deactivate (INACTIVE) and re-activate (ACTIVE)
      const deactRes = await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/status`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { status: 'INACTIVE' },
      });
      expect(deactRes.statusCode).toBe(200);
      expect(deactRes.json().status).toBe('INACTIVE');

      const reactRes = await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/status`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { status: 'ACTIVE' },
      });
      expect(reactRes.statusCode).toBe(200);
      expect(reactRes.json().status).toBe('ACTIVE');
    });

    it('enforces that only administrators can suspend and manage SUSPENDED listings', async () => {
      const { adminToken, alphaToken, skuId } = await setupActors();

      // Prepare active SKU and verified merchant
      await app.inject({
        method: 'POST',
        url: `/skus/${skuId}/status`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { status: 'ACTIVE' },
      });
      await app.inject({
        method: 'POST',
        url: '/merchants/onboard',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: {
          businessName: 'Alpha Certified',
          legalName: 'Alpha Certified Corp',
          contactEmail: 'alpha@certified.com',
        },
      });
      await app.inject({
        method: 'POST',
        url: '/merchants/me/submit',
        headers: { authorization: `Bearer ${alphaToken}` },
      });
      const prof = (
        await app.inject({
          method: 'GET',
          url: '/merchants/me',
          headers: { authorization: `Bearer ${alphaToken}` },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/merchants/${prof.tenantId}/approve`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const listing = (
        await app.inject({
          method: 'POST',
          url: '/listings',
          headers: { authorization: `Bearer ${alphaToken}` },
          payload: { skuId, priceAmount: 300000, currency: 'INR' },
        })
      ).json();

      await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/status`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { status: 'ACTIVE' },
      });

      // Merchant tries to set SUSPENDED -> FORBIDDEN
      const merchantSuspendRes = await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/status`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { status: 'SUSPENDED' },
      });
      expect(merchantSuspendRes.statusCode).toBe(403);

      // Admin suspends listing -> SUCCESS
      const adminSuspendRes = await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/status`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { status: 'SUSPENDED' },
      });
      expect(adminSuspendRes.statusCode).toBe(200);
      expect(adminSuspendRes.json().status).toBe('SUSPENDED');

      // While suspended, merchant cannot update price
      const updateAttempt = await app.inject({
        method: 'PATCH',
        url: `/listings/${listing.id}`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { priceAmount: 199900 },
      });
      expect(updateAttempt.statusCode).toBe(403);

      // Merchant cannot unsuspend
      const unsuspendAttempt = await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/status`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { status: 'ACTIVE' },
      });
      expect(unsuspendAttempt.statusCode).toBe(403);

      // Admin can lift suspension
      const adminLiftRes = await app.inject({
        method: 'POST',
        url: `/listings/${listing.id}/status`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { status: 'ACTIVE' },
      });
      expect(adminLiftRes.statusCode).toBe(200);
      expect(adminLiftRes.json().status).toBe('ACTIVE');
    });
  });

  describe('Multi-Vendor Marketplace SKU Comparison View', () => {
    it('returns active listings from all merchants sorted by price, and excludes inactive ones', async () => {
      const { adminToken, alphaToken, betaToken, skuId } = await setupActors();

      // Activate SKU
      await app.inject({
        method: 'POST',
        url: `/skus/${skuId}/status`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { status: 'ACTIVE' },
      });

      // Verify Merchant Alpha
      await app.inject({
        method: 'POST',
        url: '/merchants/onboard',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { businessName: 'Alpha', legalName: 'Alpha LLC', contactEmail: 'a@a.com' },
      });
      await app.inject({ method: 'POST', url: '/merchants/me/submit', headers: { authorization: `Bearer ${alphaToken}` } });
      const profA = (await app.inject({ method: 'GET', url: '/merchants/me', headers: { authorization: `Bearer ${alphaToken}` } })).json();
      await app.inject({ method: 'POST', url: `/merchants/${profA.tenantId}/approve`, headers: { authorization: `Bearer ${adminToken}` } });

      // Verify Merchant Beta
      await app.inject({
        method: 'POST',
        url: '/merchants/onboard',
        headers: { authorization: `Bearer ${betaToken}` },
        payload: { businessName: 'Beta', legalName: 'Beta LLC', contactEmail: 'b@b.com' },
      });
      await app.inject({ method: 'POST', url: '/merchants/me/submit', headers: { authorization: `Bearer ${betaToken}` } });
      const profB = (await app.inject({ method: 'GET', url: '/merchants/me', headers: { authorization: `Bearer ${betaToken}` } })).json();
      await app.inject({ method: 'POST', url: `/merchants/${profB.tenantId}/approve`, headers: { authorization: `Bearer ${adminToken}` } });

      // Merchant Alpha creates listing at ₹9,000 and activates
      const listA = (
        await app.inject({
          method: 'POST',
          url: '/listings',
          headers: { authorization: `Bearer ${alphaToken}` },
          payload: { skuId, priceAmount: 900000, currency: 'INR' },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/listings/${listA.id}/status`,
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { status: 'ACTIVE' },
      });

      // Merchant Beta creates listing at ₹8,500 and activates
      const listB = (
        await app.inject({
          method: 'POST',
          url: '/listings',
          headers: { authorization: `Bearer ${betaToken}` },
          payload: { skuId, priceAmount: 850000, currency: 'INR' },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/listings/${listB.id}/status`,
        headers: { authorization: `Bearer ${betaToken}` },
        payload: { status: 'ACTIVE' },
      });

      // Public multi-vendor comparison endpoint
      const comparisonRes = await app.inject({
        method: 'GET',
        url: `/skus/${skuId}/listings`,
      });
      expect(comparisonRes.statusCode).toBe(200);
      const offers = comparisonRes.json();
      expect(offers.length).toBe(2);
      // Cheaper offer first: ₹8,500 before ₹9,000
      expect(offers[0].priceAmount).toBe(850000);
      expect(offers[0].tenantId).toBe(profB.tenantId);
      expect(offers[1].priceAmount).toBe(900000);
      expect(offers[1].tenantId).toBe(profA.tenantId);

      // Confirm NO INVENTORY properties are present
      for (const offer of offers) {
        expect(offer.stockQuantity).toBeUndefined();
        expect(offer.availableQuantity).toBeUndefined();
        expect(offer.reservedQuantity).toBeUndefined();
        expect(offer.warehouseId).toBeUndefined();
      }
    });
  });
});
