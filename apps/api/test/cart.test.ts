import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase, markAllUsersVerified, registerVerifiedUser } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

describe('Phase 5: Cart Domain & Multi-Vendor Shopping Cart', () => {
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

    // 5. Catalog Setup: Category, Product, SKU
    const cat = (
      await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Electronics', slug: 'electronics' },
      })
    ).json();

    const prod = (
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'Smartphone Pro', slug: 'smartphone-pro', categoryId: cat.id },
      })
    ).json();

    // Activate Product
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
        payload: { skuCode: 'SP-PRO-BLK', attributes: { color: 'Black' } },
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
        payload: { skuCode: 'SP-PRO-SLV', attributes: { color: 'Silver' } },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/skus/${sku2.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    // 6. Listings:
    // Merchant Alpha lists SKU 1 at ₹80,000 (8000000 paise)
    const listA = (
      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { skuId: sku1.id, priceAmount: 8000000, currency: 'INR' },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/listings/${listA.id}/status`,
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { status: 'ACTIVE' },
    });

    // Merchant Beta lists SKU 2 at ₹85,000 (8500000 paise)
    const listB = (
      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${betaToken}` },
        payload: { skuId: sku2.id, priceAmount: 8500000, currency: 'INR' },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/listings/${listB.id}/status`,
      headers: { authorization: `Bearer ${betaToken}` },
      payload: { status: 'ACTIVE' },
    });

    // 7. Inventory Setup:
    // Initialize Alpha stock: 10 on-hand
    const invA = (
      await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { listingId: listA.id, initialOnHandQuantity: 10 },
      })
    ).json();

    // Initialize Beta stock: 5 on-hand
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
    };
  }

  describe('Cart Initialization & Operations', () => {
    it('creates and retrieves an active cart for authenticated customer', async () => {
      const { customer1Token } = await setupEcosystem();

      const res = await app.inject({
        method: 'GET',
        url: '/cart',
        headers: { authorization: `Bearer ${customer1Token}` },
      });

      expect(res.statusCode).toBe(200);
      const cart = res.json();
      expect(cart.id).toBeDefined();
      expect(cart.status).toBe('ACTIVE');
      expect(cart.items).toEqual([]);
      expect(cart.itemCount).toBe(0);
      expect(cart.subtotalAmount).toBe(0);
    });

    it('adds an item to cart without reserving inventory (Invariant: Cart != Reservation)', async () => {
      const { customer1Token, listingAlpha, invA, alphaToken } = await setupEcosystem();

      const addRes = await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingAlpha.id, quantity: 2 },
      });

      expect(addRes.statusCode).toBe(200);
      const cart = addRes.json();
      expect(cart.items.length).toBe(1);
      expect(cart.items[0].listingId).toBe(listingAlpha.id);
      expect(cart.items[0].quantity).toBe(2);
      expect(cart.items[0].unitPriceAmount).toBe(8000000);
      expect(cart.items[0].lineTotalAmount).toBe(16000000);
      expect(cart.subtotalAmount).toBe(16000000);

      // CRITICAL INVARIANT: Inventory MUST NOT be reserved when item enters cart
      const invRes = await app.inject({
        method: 'GET',
        url: `/inventory/${invA.id}`,
        headers: { authorization: `Bearer ${alphaToken}` },
      });
      expect(invRes.statusCode).toBe(200);
      const invData = invRes.json();
      expect(invData.onHandQuantity).toBe(10);
      expect(invData.reservedQuantity).toBe(0); // UNTOUCHED
      expect(invData.availableQuantity).toBe(10); // UNTOUCHED
    });

    it('increments quantity when duplicate listing is added to the cart', async () => {
      const { customer1Token, listingAlpha } = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingAlpha.id, quantity: 2 },
      });

      const res2 = await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingAlpha.id, quantity: 3 },
      });

      expect(res2.statusCode).toBe(200);
      const cart = res2.json();
      expect(cart.items.length).toBe(1);
      expect(cart.items[0].quantity).toBe(5);
      expect(cart.itemCount).toBe(5);
      expect(cart.subtotalAmount).toBe(40000000); // 5 * 8000000
    });

    it('supports multi-vendor cart with items from multiple merchants', async () => {
      const { customer1Token, listingAlpha, listingBeta } = await setupEcosystem();

      // Add Merchant Alpha item (2 x ₹80,000)
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingAlpha.id, quantity: 2 },
      });

      // Add Merchant Beta item (1 x ₹85,000)
      const res = await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingBeta.id, quantity: 1 },
      });

      expect(res.statusCode).toBe(200);
      const cart = res.json();
      expect(cart.items.length).toBe(2);

      const itemA = cart.items.find((i: { listingId: string }) => i.listingId === listingAlpha.id);
      const itemB = cart.items.find((i: { listingId: string }) => i.listingId === listingBeta.id);

      expect(itemA.merchantTenantId).toBe(listingAlpha.tenantId);
      expect(itemA.quantity).toBe(2);
      expect(itemA.lineTotalAmount).toBe(16000000);

      expect(itemB.merchantTenantId).toBe(listingBeta.tenantId);
      expect(itemB.quantity).toBe(1);
      expect(itemB.lineTotalAmount).toBe(8500000);

      // Subtotal = 16000000 + 8500000 = 24500000 paise (₹2,45,000)
      expect(cart.subtotalAmount).toBe(24500000);
      expect(cart.itemCount).toBe(3);
    });

    it('updates item quantity and removes item when quantity is 0', async () => {
      const { customer1Token, listingAlpha } = await setupEcosystem();

      const addRes = await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingAlpha.id, quantity: 2 },
      });
      const itemId = addRes.json().items[0].id;

      // Update quantity to 4
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/cart/items/${itemId}`,
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { quantity: 4 },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json().items[0].quantity).toBe(4);
      expect(patchRes.json().subtotalAmount).toBe(32000000);

      // Update quantity to 0 -> should remove item
      const zeroRes = await app.inject({
        method: 'PATCH',
        url: `/cart/items/${itemId}`,
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { quantity: 0 },
      });
      expect(zeroRes.statusCode).toBe(200);
      expect(zeroRes.json().items.length).toBe(0);
    });

    it('removes an item explicitly and clears cart', async () => {
      const { customer1Token, listingAlpha, listingBeta } = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingAlpha.id, quantity: 1 },
      });
      const resB = await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingBeta.id, quantity: 1 },
      });
      const itemIdA = resB.json().items.find((i: { listingId: string }) => i.listingId === listingAlpha.id).id;

      // Delete item A
      const delItemRes = await app.inject({
        method: 'DELETE',
        url: `/cart/items/${itemIdA}`,
        headers: { authorization: `Bearer ${customer1Token}` },
      });
      expect(delItemRes.statusCode).toBe(200);
      expect(delItemRes.json().items.length).toBe(1);
      expect(delItemRes.json().items[0].listingId).toBe(listingBeta.id);

      // Clear cart
      const clearRes = await app.inject({
        method: 'DELETE',
        url: '/cart',
        headers: { authorization: `Bearer ${customer1Token}` },
      });
      expect(clearRes.statusCode).toBe(200);
      expect(clearRes.json().items.length).toBe(0);
      expect(clearRes.json().subtotalAmount).toBe(0);
    });
  });

  describe('Cart Item Validation & Authoritative Pricing', () => {
    it('rejects adding invalid quantity or nonexistent listing', async () => {
      const { customer1Token, listingAlpha } = await setupEcosystem();

      // Negative quantity
      const negRes = await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingAlpha.id, quantity: -2 },
      });
      expect(negRes.statusCode).toBe(400);

      // Nonexistent listing
      const nonExistent = await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: 'nonexistent-listing-uuid', quantity: 1 },
      });
      expect(nonExistent.statusCode).toBe(404);
    });

    it('rejects client attempt to override server price', async () => {
      const { customer1Token, listingAlpha } = await setupEcosystem();

      // Client attempts to pass a forged price of 100 paise (₹1)
      const res = await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingAlpha.id, quantity: 1, price: 100 },
      });

      expect(res.statusCode).toBe(200);
      const cart = res.json();
      // Server derived authoritative price of 8000000 paise (₹80,000)
      expect(cart.items[0].unitPriceAmount).toBe(8000000);
      expect(cart.subtotalAmount).toBe(8000000);
    });
  });

  describe('Tenant Isolation & RBAC', () => {
    it('guarantees Customer A cannot read or modify Customer B cart', async () => {
      const { customer1Token, customer2Token, listingAlpha } = await setupEcosystem();

      // Customer 1 adds item
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${customer1Token}` },
        payload: { listingId: listingAlpha.id, quantity: 2 },
      });

      // Customer 2 views their cart -> must be completely empty
      const cust2Cart = await app.inject({
        method: 'GET',
        url: '/cart',
        headers: { authorization: `Bearer ${customer2Token}` },
      });
      expect(cust2Cart.statusCode).toBe(200);
      expect(cust2Cart.json().items.length).toBe(0);
      expect(cust2Cart.json().subtotalAmount).toBe(0);
    });

    it('prevents merchants from accessing customer cart endpoints', async () => {
      const { alphaToken } = await setupEcosystem();

      const res = await app.inject({
        method: 'GET',
        url: '/cart',
        headers: { authorization: `Bearer ${alphaToken}` },
      });

      // Merchant role lacks 'cart:read-own'
      expect(res.statusCode).toBe(403);
    });
  });
});
