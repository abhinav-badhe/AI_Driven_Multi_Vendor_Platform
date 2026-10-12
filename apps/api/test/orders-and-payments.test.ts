import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
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
const WEBHOOK_SECRET = 'whsec_mock_default_secret_for_tests';

describe('Phase 6: Orders & Payments', () => {
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
        payload: { name: 'Smartphones', slug: 'smartphones' },
      })
    ).json();

    const prodA = (
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          title: 'Alpha Phone Pro',
          slug: 'alpha-phone-pro',
          brand: 'BrandAlpha',
          categoryId: cat.id,
        },
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
        payload: { skuCode: 'SKU-ALPHA-128', attributes: { color: 'Black', storage: '128GB' } },
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
        payload: {
          title: 'Beta Phone Ultra',
          slug: 'beta-phone-ultra',
          brand: 'BrandBeta',
          categoryId: cat.id,
        },
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
        payload: { skuCode: 'SKU-BETA-256', attributes: { color: 'Silver', storage: '256GB' } },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/skus/${skuB.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    // 5. Merchant Listings: Alpha offers SKU A (1000 INR), Beta offers SKU B (2000 INR)
    const listA = (
      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { skuId: skuA.id, priceAmount: 1000, currency: 'INR' },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/listings/${listA.id}/status`,
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { status: 'ACTIVE' },
    });

    const listB = (
      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${betaToken}` },
        payload: { skuId: skuB.id, priceAmount: 2000, currency: 'INR' },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/listings/${listB.id}/status`,
      headers: { authorization: `Bearer ${betaToken}` },
      payload: { status: 'ACTIVE' },
    });

    // 6. Inventory: Alpha has 10 units, Beta has 5 units
    const invA = (
      await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { listingId: listA.id, skuId: skuA.id, initialOnHandQuantity: 10 },
      })
    ).json();

    const invB = (
      await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${betaToken}` },
        payload: { listingId: listB.id, skuId: skuB.id, initialOnHandQuantity: 5 },
      })
    ).json();

    // 7. Customers: Cust 1 and Cust 2
    const cust1Token = await registerVerifiedUser(app, db, {
      email: 'cust1@buyer.com',
      password: 'Password123!',
      tenantName: 'Customer One Tenant',
      role: 'CUSTOMER',
    });

    const cust2Token = await registerVerifiedUser(app, db, {
      email: 'cust2@buyer.com',
      password: 'Password123!',
      tenantName: 'Customer Two Tenant',
      role: 'CUSTOMER',
    });

    return {
      adminToken,
      alphaToken,
      betaToken,
      cust1Token,
      cust2Token,
      profA,
      profB,
      cat,
      prodA,
      skuA,
      prodB,
      skuB,
      listA,
      listB,
      invA,
      invB,
    };
  }

  // --- 1. PAYMENT INTENT & ATTEMPT LIFECYCLE ---
  describe('Payment Intent & Attempt Lifecycle', () => {
    it('creates Payment Intent for a READY checkout session with exact minor units and currency', async () => {
      const eco = await setupEcosystem();

      // Setup READY checkout
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      // Create Payment Intent
      const intentRes = await app.inject({
        method: 'POST',
        url: '/payments/intents',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { checkoutSessionId: session.id, idempotencyKey: 'pi-key-1' },
      });

      expect(intentRes.statusCode).toBe(201);
      const intent = intentRes.json();
      expect(intent.checkoutSessionId).toBe(session.id);
      expect(intent.amount).toBe(2000); // 2 * 1000 minor units
      expect(intent.currency).toBe('INR');
      expect(intent.status).toBe('CREATED');
      expect(intent.provider).toBe('mock');
      expect(intent.clientSecret).toMatch(/^pi_mock_sec_/);
    });

    it('rejects payment intent creation if checkout is not in READY status', async () => {
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

      // Session is still OPEN, not READY
      const intentRes = await app.inject({
        method: 'POST',
        url: '/payments/intents',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { checkoutSessionId: session.id },
      });

      expect(intentRes.statusCode).toBe(409);
      expect(intentRes.json().error.message).toContain("Expected 'READY'");
    });

    it('processes successful payment attempt and transitions intent to SUCCEEDED', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();

      // Submit successful payment attempt
      const attemptRes = await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent.id}/attempts`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { paymentMethod: 'pm_card_visa' },
      });

      expect(attemptRes.statusCode).toBe(200);
      const attempt = attemptRes.json();
      expect(attempt.status).toBe('SUCCEEDED');
      expect(attempt.providerTransactionId).toMatch(/^txn_/);

      // Verify intent is now SUCCEEDED
      const updatedIntent = (
        await app.inject({
          method: 'GET',
          url: `/payments/intents/${intent.id}`,
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();
      expect(updatedIntent.status).toBe('SUCCEEDED');
      expect(updatedIntent.attempts.length).toBe(1);
    });

    it('records failed payment attempt with failure reason when card is declined', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();

      // Submit declined payment
      const attemptRes = await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent.id}/attempts`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { paymentMethod: 'pm_card_declined' },
      });

      expect(attemptRes.statusCode).toBe(200);
      const attempt = attemptRes.json();
      expect(attempt.status).toBe('FAILED');
      expect(attempt.failureCode).toBe('card_declined');
      expect(attempt.failureMessage).toContain('declined');

      const updatedIntent = (
        await app.inject({
          method: 'GET',
          url: `/payments/intents/${intent.id}`,
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();
      expect(updatedIntent.status).toBe('FAILED');
    });

    it('enforces idempotency on payment intent creation and rejects key reuse with different amount', async () => {
      const eco = await setupEcosystem();

      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 1 },
      });
      const session1 = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session1.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      // Call 1
      const intent1 = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session1.id, idempotencyKey: 'stable-pi-key' },
        })
      ).json();

      // Call 2 with identical key
      const intent2 = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session1.id, idempotencyKey: 'stable-pi-key' },
        })
      ).json();

      expect(intent1.id).toBe(intent2.id);

      // Now create a different session with 2 items (amount: 2000)
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 1 },
      });
      const session2 = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session2.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      // Reusing same idempotency key with different amount must be rejected with 400
      const conflictRes = await app.inject({
        method: 'POST',
        url: '/payments/intents',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { checkoutSessionId: session2.id, idempotencyKey: 'stable-pi-key' },
      });

      expect(conflictRes.statusCode).toBe(400);
      expect(conflictRes.json().error.message).toContain(
        'idempotency key reuse with different amount',
      );
    });
  });

  // --- 2. PROVIDER WEBHOOK HANDLING & DEDUPLICATION ---
  describe('Provider Webhook Handling & Deduplication', () => {
    it('verifies webhook signature and safely updates payment intent to SUCCEEDED', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();

      // Construct verified webhook payload
      const webhookPayload = JSON.stringify({
        id: 'evt_test_1001',
        type: 'payment_intent.succeeded',
        data: {
          paymentIntentId: intent.id,
          amount: intent.amount,
          currency: intent.currency,
          status: 'SUCCEEDED',
        },
      });

      const signature = createHmac('sha256', WEBHOOK_SECRET).update(webhookPayload).digest('hex');

      const hookRes = await app.inject({
        method: 'POST',
        url: '/payments/webhooks/mock',
        headers: {
          'content-type': 'application/json',
          'x-webhook-signature': signature,
        },
        payload: webhookPayload,
      });

      expect(hookRes.statusCode).toBe(200);
      expect(hookRes.json().received).toBe(true);
      expect(hookRes.json().duplicate).toBe(false);

      // Verify intent status updated
      const updatedIntent = (
        await app.inject({
          method: 'GET',
          url: `/payments/intents/${intent.id}`,
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();
      expect(updatedIntent.status).toBe('SUCCEEDED');
    });

    it('rejects webhooks with invalid signatures with 401 Unauthorized', async () => {
      const payload = JSON.stringify({ id: 'evt_bad', type: 'payment_intent.succeeded' });

      const hookRes = await app.inject({
        method: 'POST',
        url: '/payments/webhooks/mock',
        headers: {
          'content-type': 'application/json',
          'x-webhook-signature': 'invalid_forged_signature',
        },
        payload,
      });

      expect(hookRes.statusCode).toBe(401);
    });

    it('deduplicates identical webhook deliveries without redundant processing (replay protection)', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();

      const webhookPayload = JSON.stringify({
        id: 'evt_test_replay_2002',
        type: 'payment_intent.succeeded',
        data: { paymentIntentId: intent.id, status: 'SUCCEEDED' },
      });
      const signature = createHmac('sha256', WEBHOOK_SECRET).update(webhookPayload).digest('hex');

      // Delivery 1
      const res1 = await app.inject({
        method: 'POST',
        url: '/payments/webhooks/mock',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': signature },
        payload: webhookPayload,
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json().duplicate).toBe(false);

      // Delivery 2 (Replay)
      const res2 = await app.inject({
        method: 'POST',
        url: '/payments/webhooks/mock',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': signature },
        payload: webhookPayload,
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().duplicate).toBe(true);

      // Exactly 1 webhook event record exists in database
      const countRes = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM payment_webhook_events WHERE provider_event_id = 'evt_test_replay_2002'`,
      );
      expect(parseInt(countRes.rows[0]!.count, 10)).toBe(1);
    });
  });

  // --- 3. CHECKOUT TO ORDER CONVERSION (SINGLE & MULTI-VENDOR) ---
  describe('Checkout to Order Conversion', () => {
    it('creates 1 Customer Order + 1 Seller Order from a single-vendor checkout', async () => {
      const eco = await setupEcosystem();

      // 1. Single vendor cart (Merchant Alpha)
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

      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      // 2. Pay
      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();

      await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent.id}/attempts`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { paymentMethod: 'pm_card_visa' },
      });

      // 3. Convert to Order
      const orderRes = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { checkoutSessionId: session.id, paymentIntentId: intent.id },
      });

      expect(orderRes.statusCode).toBe(201);
      const order = orderRes.json();
      expect(order.checkoutSessionId).toBe(session.id);
      expect(order.paymentIntentId).toBe(intent.id);
      expect(order.status).toBe('PAID');
      expect(order.totalAmount).toBe(2000);
      expect(order.currency).toBe('INR');

      // Canonical 1 Customer Order -> 1 Seller Order
      expect(order.sellerOrders.length).toBe(1);
      expect(order.sellerOrders[0].sellerTenantId).toBe(eco.profA.tenantId);
      expect(order.sellerOrders[0].totalAmount).toBe(2000);
      expect(order.sellerOrders[0].status).toBe('PAID');

      // Line item check
      expect(order.items.length).toBe(1);
      expect(order.items[0].productName).toBe('Alpha Phone Pro');
      expect(order.items[0].skuCode).toBe('SKU-ALPHA-128');
      expect(order.items[0].quantity).toBe(2);
      expect(order.items[0].unitPriceAmount).toBe(1000);
      expect(order.items[0].lineTotalAmount).toBe(2000);
    });

    it('places a cash-on-delivery order with no online capture', async () => {
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

      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();

      const attempt = await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent.id}/attempts`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { paymentMethod: 'cod' },
      });
      expect(attempt.statusCode).toBe(200);

      const intentRes = await app.inject({
        method: 'GET',
        url: `/payments/intents/${intent.id}`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(intentRes.json().paymentMethod).toBe('COD');

      const orderRes = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { checkoutSessionId: session.id, paymentIntentId: intent.id },
      });
      expect(orderRes.statusCode).toBe(201);
      expect(orderRes.json().paymentMethod).toBe('COD');

      const listRes = await app.inject({
        method: 'GET',
        url: '/orders',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const listed = listRes.json().find((o: { id: string }) => o.id === orderRes.json().id);
      expect(listed.paymentMethod).toBe('COD');

      // Cart is emptied once its items move onto the order.
      const cartRes = await app.inject({
        method: 'GET',
        url: '/cart',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(cartRes.statusCode).toBe(200);
      expect(cartRes.json().items).toEqual([]);
    });

    it('order placement flows into merchant analytics via outbox relay', async () => {
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

      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();

      await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent.id}/attempts`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { paymentMethod: 'pm_card_visa' },
      });

      const orderRes = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { checkoutSessionId: session.id, paymentIntentId: intent.id },
      });
      expect(orderRes.statusCode).toBe(201);

      // Analytics is empty before the relay runs.
      const before = await app.inject({
        method: 'GET',
        url: '/analytics/sales',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      });
      expect(before.json().totals.totalOrders).toBe(0);

      // Run the outbox relay as admin, then merchant analytics reflects the order.
      const relay = await app.inject({
        method: 'POST',
        url: '/events/outbox/process',
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { batchSize: 50 },
      });
      expect(relay.statusCode).toBe(200);

      const salesRes = await app.inject({
        method: 'GET',
        url: '/analytics/sales',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      });
      expect(salesRes.statusCode).toBe(200);
      const sales = salesRes.json();
      expect(sales.totals.totalOrders).toBe(1);
      expect(sales.totals.grossSales).toBe('2000.0000');
      expect(sales.trends.length).toBeGreaterThan(0);

      const productsRes = await app.inject({
        method: 'GET',
        url: '/analytics/products',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      });
      expect(productsRes.statusCode).toBe(200);
      expect(productsRes.json().products).toHaveLength(1);
      expect(productsRes.json().products[0].unitsSold).toBe(2);

      const opsRes = await app.inject({
        method: 'GET',
        url: '/analytics/operations',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      });
      expect(opsRes.statusCode).toBe(200);
      expect(opsRes.json().operations.paymentSuccessCount).toBe(1);

      // Merchant-triggered rebuild keeps working and preserves the facts.
      const rebuild = await app.inject({
        method: 'POST',
        url: '/analytics/rebuild',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {},
      });
      expect(rebuild.statusCode).toBe(200);
      expect(rebuild.json().status).toBe('COMPLETED');
    });

    it('creates 1 Customer Order + N Seller Orders from a multi-vendor checkout', async () => {
      const eco = await setupEcosystem();

      // Multi-vendor cart: 2 units from Alpha (2000 INR) + 1 unit from Beta (2000 INR) = 4000 INR
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

      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();

      await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent.id}/attempts`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { paymentMethod: 'pm_card_visa' },
      });

      const orderRes = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { checkoutSessionId: session.id, paymentIntentId: intent.id },
      });

      expect(orderRes.statusCode).toBe(201);
      const order = orderRes.json();
      expect(order.totalAmount).toBe(4000);

      // Exactly 2 distinct Seller Orders created
      expect(order.sellerOrders.length).toBe(2);

      const sellerAlpha = order.sellerOrders.find(
        (s: { sellerTenantId: string }) => s.sellerTenantId === eco.profA.tenantId,
      );
      const sellerBeta = order.sellerOrders.find(
        (s: { sellerTenantId: string }) => s.sellerTenantId === eco.profB.tenantId,
      );

      expect(sellerAlpha).toBeDefined();
      expect(sellerAlpha.totalAmount).toBe(2000);

      expect(sellerBeta).toBeDefined();
      expect(sellerBeta.totalAmount).toBe(2000);

      // Total items = 2
      expect(order.items.length).toBe(2);
    });

    it('guarantees immutable historical snapshots of product name and variant attributes', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent.id}/attempts`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const order = (
        await app.inject({
          method: 'POST',
          url: '/orders',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id, paymentIntentId: intent.id },
        })
      ).json();

      expect(order.items[0].productName).toBe('Alpha Phone Pro');

      // Now mutate catalog product in database
      await db.query(`UPDATE products SET title = 'Alpha Phone Mutated Title' WHERE id = $1`, [
        eco.prodA.id,
      ]);

      // Re-read order
      const fetchedOrder = (
        await app.inject({
          method: 'GET',
          url: `/orders/${order.id}`,
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();

      // Historical snapshot remains preserved
      expect(fetchedOrder.items[0].productName).toBe('Alpha Phone Pro');
    });

    it('rejects order creation if payment intent has not succeeded', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();

      // Intent is only CREATED, not paid
      const orderRes = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { checkoutSessionId: session.id, paymentIntentId: intent.id },
      });

      expect(orderRes.statusCode).toBe(409);
      expect(orderRes.json().error.message).toContain('Payment intent');
      expect(orderRes.json().error.message).toContain('has not succeeded');
    });
  });

  // --- 4. INVENTORY RESERVATION CONSUMPTION INVARIANT ---
  describe('Inventory Reservation Consumption Invariant', () => {
    it('consumes inventory reservations through public Inventory interface when order is created', async () => {
      const eco = await setupEcosystem();

      // Initially Alpha on_hand = 10, reserved = 0, available = 10
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      // After reserve: on_hand = 10, reserved = 3, available = 7
      let inv = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(inv.onHandQuantity).toBe(10);
      expect(inv.reservedQuantity).toBe(3);
      expect(inv.availableQuantity).toBe(7);

      // Pay & Finalize Order
      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent.id}/attempts`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const order = (
        await app.inject({
          method: 'POST',
          url: '/orders',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id, paymentIntentId: intent.id },
        })
      ).json();

      expect(order.status).toBe('PAID');

      // After Order: on_hand = 7, reserved = 0, available = 7!
      inv = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(inv.onHandQuantity).toBe(7);
      expect(inv.reservedQuantity).toBe(0);
      expect(inv.availableQuantity).toBe(7);

      // Verify movement ledger recorded RESERVATION_CONSUME
      const moveRes = await db.query<{ movement_type: string; quantity_delta: number }>(
        `SELECT movement_type, quantity_delta FROM inventory_movements WHERE inventory_id = $1 AND movement_type = 'RESERVATION_CONSUME'`,
        [eco.invA.id],
      );
      expect(moveRes.rows.length).toBe(1);
      expect(moveRes.rows[0]!.movement_type).toBe('RESERVATION_CONSUME');
      expect(moveRes.rows[0]!.quantity_delta).toBe(-3);
    });
  });

  // --- 5. IDEMPOTENCY & CRASH RECOVERY ---
  describe('Idempotency & Crash Recovery', () => {
    it('guarantees identical response and zero duplicate orders when order creation is retried', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent.id}/attempts`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      // Retry 1
      const order1 = (
        await app.inject({
          method: 'POST',
          url: '/orders',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: {
            checkoutSessionId: session.id,
            paymentIntentId: intent.id,
            idempotencyKey: 'ord-retry-key',
          },
        })
      ).json();

      // Retry 2
      const order2 = (
        await app.inject({
          method: 'POST',
          url: '/orders',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: {
            checkoutSessionId: session.id,
            paymentIntentId: intent.id,
            idempotencyKey: 'ord-retry-key',
          },
        })
      ).json();

      expect(order1.id).toBe(order2.id);
      expect(order1.sellerOrders[0].id).toBe(order2.sellerOrders[0].id);

      // Exactly 1 customer order in database
      const countRes = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM customer_orders WHERE checkout_session_id = $1`,
        [session.id],
      );
      expect(parseInt(countRes.rows[0]!.count, 10)).toBe(1);
    });

    it('simulates lost response after payment and verifies safe recovery', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      // Payment intent created and succeeded
      const intent1 = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id, idempotencyKey: 'crash-key-1' },
        })
      ).json();

      await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent1.id}/attempts`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      // Client assumed lost response and retries intent creation
      const intent2 = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id, idempotencyKey: 'crash-key-1' },
        })
      ).json();

      expect(intent1.id).toBe(intent2.id);
      expect(intent2.status).toBe('SUCCEEDED');
    });
  });

  // --- 6. TENANT ISOLATION & RBAC ---
  describe('Tenant Isolation & RBAC', () => {
    it('prevents Customer A from accessing Customer B order', async () => {
      const eco = await setupEcosystem();

      // Cust 1 creates order
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent.id}/attempts`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const order = (
        await app.inject({
          method: 'POST',
          url: '/orders',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id, paymentIntentId: intent.id },
        })
      ).json();

      // Customer 2 attempts to read Customer 1's order
      const getRes = await app.inject({
        method: 'GET',
        url: `/orders/${order.id}`,
        headers: { authorization: `Bearer ${eco.cust2Token}` },
      });

      expect(getRes.statusCode).toBe(403);
      expect(getRes.json().error.message).toContain('Tenant isolation violation');
    });

    it('prevents Merchant Alpha from reading Merchant Beta Seller Order', async () => {
      const eco = await setupEcosystem();

      // Multi-vendor checkout
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 1 },
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent.id}/attempts`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const order = (
        await app.inject({
          method: 'POST',
          url: '/orders',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id, paymentIntentId: intent.id },
        })
      ).json();

      const sellerBeta = order.sellerOrders.find(
        (s: { sellerTenantId: string }) => s.sellerTenantId === eco.profB.tenantId,
      );

      // Merchant Alpha attempts to view Merchant Beta's seller order
      const readRes = await app.inject({
        method: 'GET',
        url: `/seller/orders/${sellerBeta.id}`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      });

      expect(readRes.statusCode).toBe(403);
      expect(readRes.json().error.message).toContain('Tenant isolation violation');

      // Merchant Beta can access their own seller order
      const betaReadRes = await app.inject({
        method: 'GET',
        url: `/seller/orders/${sellerBeta.id}`,
        headers: { authorization: `Bearer ${eco.betaToken}` },
      });
      expect(betaReadRes.statusCode).toBe(200);
      expect(betaReadRes.json().id).toBe(sellerBeta.id);
    });

    it('prevents customers from accessing seller-order endpoints', async () => {
      const eco = await setupEcosystem();

      const res = await app.inject({
        method: 'GET',
        url: '/seller/orders',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // --- 7. SELLER ORDER LIFECYCLE & STATE MACHINE ---
  describe('Seller Order Lifecycle & State Machine', () => {
    it('allows merchant to transition their seller order through valid states and rejects invalid transitions', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent.id}/attempts`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const order = (
        await app.inject({
          method: 'POST',
          url: '/orders',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id, paymentIntentId: intent.id },
        })
      ).json();

      const sellerOrder = order.sellerOrders[0];
      expect(sellerOrder.status).toBe('PAID');

      // Valid: PAID -> PROCESSING
      const patch1 = await app.inject({
        method: 'PATCH',
        url: `/seller/orders/${sellerOrder.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'PROCESSING' },
      });
      expect(patch1.statusCode).toBe(200);
      expect(patch1.json().status).toBe('PROCESSING');

      // Invalid: PROCESSING -> PAID (backwards transition)
      const patch2 = await app.inject({
        method: 'PATCH',
        url: `/seller/orders/${sellerOrder.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'PAID' },
      });
      expect(patch2.statusCode).toBe(409);
      expect(patch2.json().error.message).toContain('Invalid seller order transition');

      // Valid: PROCESSING -> COMPLETED
      const patch3 = await app.inject({
        method: 'PATCH',
        url: `/seller/orders/${sellerOrder.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'COMPLETED' },
      });
      expect(patch3.statusCode).toBe(200);
      expect(patch3.json().status).toBe('COMPLETED');
    });
  });

  // --- 8. REFUND FOUNDATION ---
  describe('Refund Foundation', () => {
    it('allows administrator to issue a refund against a succeeded payment intent', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent.id}/attempts`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      // Admin creates refund
      const refundRes = await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent.id}/refund`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { amount: 1000, reason: 'Customer cancellation', idempotencyKey: 'ref-key-1' },
      });

      expect(refundRes.statusCode).toBe(201);
      const refund = refundRes.json();
      expect(refund.status).toBe('SUCCEEDED');
      expect(refund.amount).toBe(1000);
      expect(refund.providerRefundId).toMatch(/^ref_mock_/);
    });

    it('rejects refund attempts by non-administrators with 403 Forbidden', async () => {
      const eco = await setupEcosystem();

      const refundRes = await app.inject({
        method: 'POST',
        url: '/payments/intents/some-intent-id/refund',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { amount: 100 },
      });

      expect(refundRes.statusCode).toBe(403);
    });
  });

  // --- 8. PHASE 6 GATE VERIFICATION: CONCURRENCY, MONOTONICITY & IMMUTABILITY ---
  describe('Phase 6 Gate Verification: Concurrency, Monotonicity & Immutability', () => {
    it('handles concurrent identical webhook deliveries safely without duplicating ledger entries', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();

      const webhookPayload = JSON.stringify({
        id: 'evt_concurrent_1001',
        type: 'payment_intent.succeeded',
        data: { paymentIntentId: intent.id, status: 'SUCCEEDED' },
      });
      const signature = createHmac('sha256', WEBHOOK_SECRET).update(webhookPayload).digest('hex');

      // Send 5 identical webhooks simultaneously
      const results = await Promise.all(
        Array.from({ length: 5 }).map(() =>
          app.inject({
            method: 'POST',
            url: '/payments/webhooks/mock',
            headers: { 'content-type': 'application/json', 'x-webhook-signature': signature },
            payload: webhookPayload,
          }),
        ),
      );

      for (const res of results) {
        expect(res.statusCode).toBe(200);
      }

      // Exactly 1 webhook event record persisted in DB
      const dbCount = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM payment_webhook_events WHERE provider_event_id = 'evt_concurrent_1001'`,
      );
      expect(parseInt(dbCount.rows[0]!.count, 10)).toBe(1);

      // Payment intent is SUCCEEDED
      const intentCheck = await app.inject({
        method: 'GET',
        url: `/payments/intents/${intent.id}`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(intentCheck.json().status).toBe('SUCCEEDED');
    });

    it('out-of-order webhook: prevents FAILED event from regressing an already SUCCEEDED intent', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();

      // Step 1: SUCCEEDED webhook arrives
      const payloadSuccess = JSON.stringify({
        id: 'evt_seq_success_1',
        type: 'payment_intent.succeeded',
        data: { paymentIntentId: intent.id, status: 'SUCCEEDED' },
      });
      const sigSuccess = createHmac('sha256', WEBHOOK_SECRET).update(payloadSuccess).digest('hex');

      const resSuccess = await app.inject({
        method: 'POST',
        url: '/payments/webhooks/mock',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': sigSuccess },
        payload: payloadSuccess,
      });
      expect(resSuccess.statusCode).toBe(200);

      // Step 2: Late/out-of-order FAILED webhook arrives
      const payloadFail = JSON.stringify({
        id: 'evt_seq_fail_2',
        type: 'payment_intent.payment_failed',
        data: { paymentIntentId: intent.id, status: 'FAILED' },
      });
      const sigFail = createHmac('sha256', WEBHOOK_SECRET).update(payloadFail).digest('hex');

      const resFail = await app.inject({
        method: 'POST',
        url: '/payments/webhooks/mock',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': sigFail },
        payload: payloadFail,
      });
      expect(resFail.statusCode).toBe(200);

      // Intent must remain strictly SUCCEEDED
      const intentCheck = await app.inject({
        method: 'GET',
        url: `/payments/intents/${intent.id}`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(intentCheck.json().status).toBe('SUCCEEDED');
    });

    it('out-of-order webhook: prevents SUCCEEDED event from overriding an already FAILED intent', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();

      // Step 1: FAILED webhook arrives
      const payloadFail = JSON.stringify({
        id: 'evt_seq_fail_1',
        type: 'payment_intent.payment_failed',
        data: { paymentIntentId: intent.id, status: 'FAILED' },
      });
      const sigFail = createHmac('sha256', WEBHOOK_SECRET).update(payloadFail).digest('hex');

      const resFail = await app.inject({
        method: 'POST',
        url: '/payments/webhooks/mock',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': sigFail },
        payload: payloadFail,
      });
      expect(resFail.statusCode).toBe(200);

      // Intent is FAILED
      const intentCheck1 = await app.inject({
        method: 'GET',
        url: `/payments/intents/${intent.id}`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(intentCheck1.json().status).toBe('FAILED');

      // Step 2: Late SUCCEEDED webhook arrives
      const payloadSuccess = JSON.stringify({
        id: 'evt_seq_success_2',
        type: 'payment_intent.succeeded',
        data: { paymentIntentId: intent.id, status: 'SUCCEEDED' },
      });
      const sigSuccess = createHmac('sha256', WEBHOOK_SECRET).update(payloadSuccess).digest('hex');

      const resSuccess = await app.inject({
        method: 'POST',
        url: '/payments/webhooks/mock',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': sigSuccess },
        payload: payloadSuccess,
      });
      expect(resSuccess.statusCode).toBe(200);

      // Intent must remain FAILED (cannot move backward from terminal failure)
      const intentCheck2 = await app.inject({
        method: 'GET',
        url: `/payments/intents/${intent.id}`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(intentCheck2.json().status).toBe('FAILED');
    });

    it('rejects payment intent idempotency key reuse with a different checkout session', async () => {
      const eco = await setupEcosystem();

      // Session 1
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 1 },
      });
      const session1 = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session1.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      // Session 2
      const session2 = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session2.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      // Create Intent for Session 1 with key
      const res1 = await app.inject({
        method: 'POST',
        url: '/payments/intents',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { checkoutSessionId: session1.id, idempotencyKey: 'shared-intent-key-1' },
      });
      expect(res1.statusCode).toBe(201);

      // Attempt to reuse key for Session 2
      const res2 = await app.inject({
        method: 'POST',
        url: '/payments/intents',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { checkoutSessionId: session2.id, idempotencyKey: 'shared-intent-key-1' },
      });
      expect(res2.statusCode).toBe(400);
    });

    it('rejects order creation idempotency key reuse with a different checkout session', async () => {
      const eco = await setupEcosystem();

      // Session 1
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 1 },
      });
      const session1 = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session1.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      const intent1 = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session1.id },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent1.id}/attempts`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { paymentMethod: 'pm_card_visa' },
      });

      // Order 1 succeeds
      const orderRes1 = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: {
          checkoutSessionId: session1.id,
          paymentIntentId: intent1.id,
          idempotencyKey: 'order-shared-key-1',
        },
      });
      expect(orderRes1.statusCode).toBe(201);

      // Session 2
      await app.inject({
        method: 'POST',
        url: '/cart/items',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { listingId: eco.listA.id, quantity: 1 },
      });
      const session2 = (
        await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session2.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      const intent2 = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session2.id },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent2.id}/attempts`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { paymentMethod: 'pm_card_visa' },
      });

      // Try creating Order 2 with Order 1's idempotency key
      const orderRes2 = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: {
          checkoutSessionId: session2.id,
          paymentIntentId: intent2.id,
          idempotencyKey: 'order-shared-key-1',
        },
      });
      expect(orderRes2.statusCode).toBe(400);
    });

    it('order item snapshots remain strictly immutable even after subsequent catalog product/sku updates', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent.id}/attempts`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { paymentMethod: 'pm_card_visa' },
      });

      const orderRes = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { checkoutSessionId: session.id, paymentIntentId: intent.id },
      });
      expect(orderRes.statusCode).toBe(201);
      const originalOrder = orderRes.json();
      const originalItem = originalOrder.items[0];
      expect(originalItem.productName).toBe('Alpha Phone Pro');
      expect(originalItem.unitPriceAmount).toBe(1000);

      // Modify the underlying catalog product and listing price
      await db.query(`UPDATE products SET title = 'ALTERED TITLE NEVER IN ORDER' WHERE id = $1`, [
        originalItem.productId,
      ]);
      await db.query(`UPDATE merchant_listings SET price_amount = 999999 WHERE id = $1`, [
        originalItem.listingId,
      ]);

      // Fetch the customer order again
      const fetchedOrderRes = await app.inject({
        method: 'GET',
        url: `/orders/${originalOrder.id}`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(fetchedOrderRes.statusCode).toBe(200);
      const fetchedOrder = fetchedOrderRes.json();
      const fetchedItem = fetchedOrder.items[0];

      // Snapshots MUST remain identical to historical state
      expect(fetchedItem.productName).toBe('Alpha Phone Pro');
      expect(fetchedItem.unitPriceAmount).toBe(1000);
      expect(fetchedOrder.totalAmount).toBe(originalOrder.totalAmount);
    });

    it('rejects order creation if payment intent amount or currency does not match checkout', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });

      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/payments/intents/${intent.id}/attempts`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { paymentMethod: 'pm_card_visa' },
      });

      // Tamper with the payment intent amount in the database
      await db.query(`UPDATE payment_intents SET amount = 99999 WHERE id = $1`, [intent.id]);

      const orderRes = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { checkoutSessionId: session.id, paymentIntentId: intent.id },
      });

      expect(orderRes.statusCode).toBe(400);
      expect(orderRes.json().error.message).toMatch(
        /Payment amount\/currency .* does not match checkout/,
      );
    });
  });

  // --- 9. PAYMENT SUCCESS -> ORDER CREATION CRASH RECOVERY ---
  describe('Payment Success -> Order Creation Crash Recovery', () => {
    it('durably creates order via outbox event when client crashes before POST /orders', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();

      // Send webhook for payment success (simulates client crashing before POST /orders)
      const webhookPayload = JSON.stringify({
        id: 'evt_crash_recovery_01',
        type: 'payment_intent.succeeded',
        data: { paymentIntentId: intent.id, status: 'SUCCEEDED' },
      });
      const signature = createHmac('sha256', WEBHOOK_SECRET).update(webhookPayload).digest('hex');

      const hookRes = await app.inject({
        method: 'POST',
        url: '/payments/webhooks/mock',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': signature },
        payload: webhookPayload,
      });
      expect(hookRes.statusCode).toBe(200);

      // Trigger outbox worker explicitly
      await app.inject({
        method: 'POST',
        url: '/events/outbox/process',
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });

      // Verify order was created automatically
      const orderCheckRes = await app.inject({
        method: 'GET',
        url: '/orders',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      expect(orderCheckRes.statusCode).toBe(200);
      const orders = orderCheckRes.json();
      expect(orders.length).toBe(1);
      expect(orders[0].checkoutSessionId).toBe(session.id);
      expect(orders[0].paymentIntentId).toBe(intent.id);
    });

    it('deduplicates concurrent POST /orders and webhook outbox event, creating exactly 1 order', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${session.id}/reserve`,
        headers: { authorization: `Bearer ${eco.cust1Token}` },
      });
      const intent = (
        await app.inject({
          method: 'POST',
          url: '/payments/intents',
          headers: { authorization: `Bearer ${eco.cust1Token}` },
          payload: { checkoutSessionId: session.id },
        })
      ).json();

      // Trigger webhook success
      const webhookPayload = JSON.stringify({
        id: 'evt_crash_recovery_02',
        type: 'payment_intent.succeeded',
        data: { paymentIntentId: intent.id, status: 'SUCCEEDED' },
      });
      const signature = createHmac('sha256', WEBHOOK_SECRET).update(webhookPayload).digest('hex');
      await app.inject({
        method: 'POST',
        url: '/payments/webhooks/mock',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': signature },
        payload: webhookPayload,
      });

      // Client concurrently sends POST /orders
      const clientOrderPromise = app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${eco.cust1Token}` },
        payload: { checkoutSessionId: session.id, paymentIntentId: intent.id },
      });

      // System concurrently processes outbox event
      const eventPromise = app.inject({
        method: 'POST',
        url: '/events/outbox/process',
        headers: { authorization: `Bearer ${eco.adminToken}` },
      });

      const [clientOrderRes, eventRes] = await Promise.all([clientOrderPromise, eventPromise]);

      expect(clientOrderRes.statusCode).toBe(201);
      expect(eventRes.statusCode).toBe(200);

      // Verify exactly 1 order exists for this checkout
      const dbCount = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM customer_orders WHERE checkout_session_id = $1`,
        [session.id],
      );
      expect(parseInt(dbCount.rows[0]!.count, 10)).toBe(1);
    });
  });
});
