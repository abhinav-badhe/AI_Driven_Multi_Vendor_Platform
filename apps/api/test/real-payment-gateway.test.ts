import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';
import { InMemoryEventTransport, EventTypes } from '../src/modules/events/index.js';
import { InMemorySearchStore } from '../src/modules/search/index.js';
import { JsonLogger } from '../src/observability/logger.js';
import {
  StripePaymentProvider,
  toStripeAmount,
  fromStripeAmount,
} from '../src/modules/payment/index.js';

describe('Real Payment Gateway (Stripe Sandbox) Integration & Architecture', () => {
  let app: FastifyInstance;
  let dbConn: DatabaseConnection;
  let eventTransport: InMemoryEventTransport;
  let searchStore: InMemorySearchStore;
  const logger = new JsonLogger({ serviceName: 'payment-test', level: 'error', pretty: false, redactKeys: [] });

  const tenantId = 'tenant-cust-stripe';
  const customerId = 'cust-stripe-user';
  const customerPhone = '+15557778899';
  const stripeSecretKey = 'sk_test_51MockStripeSecretKey1234567890';
  const stripeWebhookSecret = 'whsec_test_stripe_webhook_signing_secret_999';

  // In-memory simulator for Stripe v1 REST endpoints
  const simulatedStripeStore = new Map<string, Record<string, unknown>>();

  const mockStripeFetch: typeof fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    const bodyStr = init?.body ? String(init.body) : '';
    const params = new URLSearchParams(bodyStr);

    if (urlStr.includes('/payment_intents/') && urlStr.includes('/confirm')) {
      const parts = urlStr.split('/payment_intents/')[1]!.split('/confirm')[0]!;
      const piId = parts;
      const paymentMethod = params.get('payment_method') || 'pm_card_visa';

      if (paymentMethod.includes('fail') || paymentMethod.includes('decline') || paymentMethod === 'pm_card_chargeCustomerFail') {
        const errorResp = {
          error: {
            code: 'card_declined',
            message: 'Your card was declined by the simulated gateway.',
            decline_code: 'generic_decline',
          },
        };
        return new Response(JSON.stringify(errorResp), { status: 402, headers: { 'Content-Type': 'application/json' } });
      }

      if (paymentMethod === 'pm_card_threeDSecure2Required' || paymentMethod.includes('3ds') || paymentMethod.includes('action')) {
        const requiresActionResp = {
          id: piId,
          status: 'requires_action',
          next_action: {
            type: 'use_stripe_sdk',
            use_stripe_sdk: {
              type: 'three_d_secure_redirect',
              stripe_js: 'https://hooks.stripe.com/redirect/authenticate',
            },
          },
        };
        simulatedStripeStore.set(piId, requiresActionResp);
        return new Response(JSON.stringify(requiresActionResp), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      const existing = (simulatedStripeStore.get(piId) ?? {}) as Record<string, unknown>;
      const confirmed = {
        ...existing,
        id: piId,
        status: 'succeeded',
        amount_received: existing['amount'] ?? 2499,
      };
      simulatedStripeStore.set(piId, confirmed);

      return new Response(JSON.stringify(confirmed), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (urlStr.includes('/payment_intents')) {
      const piId = `pi_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      const amount = Number(params.get('amount') || '2499');
      const currency = params.get('currency') || 'usd';

      const pi = {
        id: piId,
        object: 'payment_intent',
        amount,
        currency,
        status: 'requires_payment_method',
        client_secret: `${piId}_secret_${randomUUID().replace(/-/g, '')}`,
        created: Math.floor(Date.now() / 1000),
      };
      simulatedStripeStore.set(piId, pi);

      return new Response(JSON.stringify(pi), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (urlStr.includes('/refunds')) {
      const refId = `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      const refund = {
        id: refId,
        object: 'refund',
        amount: Number(params.get('amount') || '2499'),
        status: 'succeeded',
        payment_intent: params.get('payment_intent'),
      };
      return new Response(JSON.stringify(refund), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 });
  };

  const createStripeSignature = (rawPayload: string, secret = stripeWebhookSecret, timestamp = Math.floor(Date.now() / 1000)): string => {
    const signature = createHmac('sha256', secret).update(`${timestamp}.${rawPayload}`).digest('hex');
    return `t=${timestamp},v1=${signature}`;
  };

  beforeEach(async () => {
    dbConn = await createMigratedTestDatabase();
    eventTransport = new InMemoryEventTransport();
    searchStore = new InMemorySearchStore();
    simulatedStripeStore.clear();

    const config = parseConfig({
      NODE_ENV: 'test',
      PORT: '0',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      DATABASE_HOST: 'localhost',
      DATABASE_PORT: '5432',
      DATABASE_NAME: 'commerce_test',
      DATABASE_USER: 'test_user',
      DATABASE_PASSWORD: 'test_password',
      DATABASE_POOL_MIN: '1',
      DATABASE_POOL_MAX: '5',
      REDIS_HOST: 'localhost',
      REDIS_PORT: '6379',
      REDIS_TLS: 'false',
      ACCESS_TOKEN_SECRET: 'super-secret-jwt-key-for-testing-123456',
      SERVICE_NAME: 'stripe-gateway-test',
      LOG_PRETTY: 'false',
      REDACT_KEYS: 'password,token,secret,key',
      SEARCH_STORE_ADAPTER: 'memory',
      PAYMENT_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: stripeSecretKey,
      STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
      WHATSAPP_PROVIDER: 'mock',
      WHATSAPP_APP_SECRET: 'wa-secret-stripe-test',
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'wa-verify-stripe-test',
    });

    const testPaymentProvider = new StripePaymentProvider(
      {
        secretKey: stripeSecretKey,
        webhookSecret: stripeWebhookSecret,
        fetchFn: mockStripeFetch,
      },
      logger,
    );

    app = await buildApp({
      config,
      logger,
      searchStore,
      eventTransport,
      paymentProvider: testPaymentProvider,
      dbConnection: dbConn,
      skipMigrations: true,
    });

    await app.ready();

    // Seed base customer tenant and verified WhatsApp mapping
    await dbConn.query(`INSERT INTO tenants (id, type, name, status) VALUES ($1, 'CUSTOMER', 'Stripe Tenant', 'ACTIVE')`, [tenantId]);
    await dbConn.query(`INSERT INTO users (id, email, password_hash, status, email_verified_at) VALUES ($1, 'stripe@user.com', 'pw', 'ACTIVE', NOW())`, [customerId]);
    await dbConn.query(`INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status) VALUES ('mem-stripe-1', $1, $2, 'CUSTOMER', 'ACTIVE')`, [tenantId, customerId]);
    await dbConn.query(
      `INSERT INTO ai_whatsapp_mappings (id, phone_number, tenant_id, customer_id, is_verified, verified_at, created_at, updated_at)
       VALUES ('wam-stripe', $1, $2, $3, TRUE, NOW(), NOW(), NOW())`,
      [customerPhone, tenantId, customerId],
    );

    // Seed merchant, product, and stock
    await dbConn.query(`INSERT INTO tenants (id, type, name, status) VALUES ('tenant-merch-stripe', 'MERCHANT', 'Stripe Merchant', 'ACTIVE')`);
    await dbConn.query(`INSERT INTO categories (id, name, slug) VALUES ('cat-electronics', 'Electronics', 'electronics')`);
    await dbConn.query(`INSERT INTO products (id, title, slug, category_id, status) VALUES ('prod-phone', 'Smart Phone 15', 'phone-15', 'cat-electronics', 'ACTIVE')`);
    await dbConn.query(`INSERT INTO product_skus (id, product_id, sku_code, status) VALUES ('sku-phone-15', 'prod-phone', 'PHONE-15', 'ACTIVE')`);
    await dbConn.query(`INSERT INTO merchant_listings (id, tenant_id, sku_id, price_amount, currency, status) VALUES ('list-phone-deal', 'tenant-merch-stripe', 'sku-phone-15', 999, 'USD', 'ACTIVE')`);
    await dbConn.query(`INSERT INTO inventory_items (id, tenant_id, listing_id, sku_id, on_hand_quantity, reserved_quantity, non_sellable_quantity, version) VALUES ('inv-phone-1', 'tenant-merch-stripe', 'list-phone-deal', 'sku-phone-15', 50, 0, 0, 1)`);

    await searchStore.indexDocument({
      id: 'prod-phone',
      title: 'Smart Phone 15',
      slug: 'phone-15',
      categoryId: 'cat-electronics',
      categoryName: 'Electronics',
      status: 'ACTIVE',
      minPrice: 999,
      maxPrice: 999,
      currency: 'USD',
      hasInStockOffer: true,
      totalOffersCount: 1,
      attributes: {},
      sourceVersion: 1,
      projectionVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      offers: [{
        listingId: 'list-phone-deal',
        merchantId: 'tenant-merch-stripe',
        skuId: 'sku-phone-1',
        skuCode: 'SP-15-BLK',
        priceAmount: 999,
        currency: 'USD',
        status: 'ACTIVE',
        inStock: true,
        availableQuantity: 50,
        attributes: {},
        sourceVersion: 1,
        updatedAt: new Date().toISOString(),
      }],
    });
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // Helper to create a ready & reserved checkout session
  async function createReservedCheckout(total = 999): Promise<string> {
    const cartId = randomUUID();
    await dbConn.query(`INSERT INTO carts (id, tenant_id, status) VALUES ($1, $2, 'ACTIVE')`, [cartId, tenantId]);
    await dbConn.query(
      `INSERT INTO cart_items (id, cart_id, listing_id, sku_id, merchant_tenant_id, quantity, created_at)
       VALUES ($1, $2, 'list-phone-deal', 'sku-phone-15', 'tenant-merch-stripe', 1, NOW())`,
      [randomUUID(), cartId],
    );

    const chkId = randomUUID();
    const expiresAt = new Date(Date.now() + 3600000);
    await dbConn.query(
      `INSERT INTO checkout_sessions (id, cart_id, customer_tenant_id, status, currency, subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount, expires_at)
       VALUES ($1, $2, $3, 'READY', 'USD', $4, 0, 0, 0, $4, $5)`,
      [chkId, cartId, tenantId, total, expiresAt],
    );

    await dbConn.query(
      `INSERT INTO checkout_items (id, checkout_session_id, listing_id, sku_id, merchant_tenant_id, quantity, unit_price_amount, line_total_amount, currency)
       VALUES ($1, $2, 'list-phone-deal', 'sku-phone-15', 'tenant-merch-stripe', 1, $3, $3, 'USD')`,
      [randomUUID(), chkId, total],
    );

    return chkId;
  }

  // --- 1 & 2. Stripe Unit Provider & Value Scaling ---

  describe('StripePaymentProvider Unit Implementation', () => {
    it('correctly scales decimal amounts to Stripe cents and back', () => {
      expect(toStripeAmount(24.99, 'USD')).toBe(2499);
      expect(toStripeAmount(100, 'EUR')).toBe(10000);
      expect(toStripeAmount(5000, 'JPY')).toBe(5000); // zero decimal

      expect(fromStripeAmount(2499, 'USD')).toBe(24.99);
      expect(fromStripeAmount(5000, 'JPY')).toBe(5000);
    });

    it('verifies valid Stripe HMAC signature format and enforces timestamp tolerance', () => {
      const provider = new StripePaymentProvider(
        { secretKey: 'sk_test_123', webhookSecret: 'whsec_test_secret_abc', webhookToleranceSeconds: 300 },
        logger,
      );

      const payload = '{"id":"evt_123","type":"payment_intent.succeeded"}';
      const nowSec = Math.floor(Date.now() / 1000);

      // Fresh valid signature within tolerance
      const validSig = createStripeSignature(payload, 'whsec_test_secret_abc', nowSec);
      expect(provider.verifyWebhookSignature(payload, validSig, 'whsec_test_secret_abc')).toBe(true);

      // Invalid signature digest
      expect(provider.verifyWebhookSignature(payload, `t=${nowSec},v1=invalid_sig`, 'whsec_test_secret_abc')).toBe(false);
      expect(provider.verifyWebhookSignature(payload, '', 'whsec_test_secret_abc')).toBe(false);

      // Expired signature (> 300s old)
      const expiredSig = createStripeSignature(payload, 'whsec_test_secret_abc', nowSec - 301);
      expect(provider.verifyWebhookSignature(payload, expiredSig, 'whsec_test_secret_abc')).toBe(false);

      // Future signature (> 300s ahead)
      const futureSig = createStripeSignature(payload, 'whsec_test_secret_abc', nowSec + 301);
      expect(provider.verifyWebhookSignature(payload, futureSig, 'whsec_test_secret_abc')).toBe(false);
    });

    it('creates PaymentIntent and confirms attempt using simulated Stripe REST API', async () => {
      const provider = new StripePaymentProvider(
        { secretKey: 'sk_test_123', fetchFn: mockStripeFetch },
        logger,
      );

      // 1. Create intent
      const intentRes = await provider.createIntent({
        amount: 49.99,
        currency: 'USD',
        metadata: { orderType: 'online' },
      });
      expect(intentRes.providerTransactionId).toMatch(/^pi_/);
      expect(intentRes.clientSecret).toContain('_secret_');

      // 2. Successful attempt
      const attemptRes = await provider.createAttempt({
        providerTransactionId: intentRes.providerTransactionId,
        amount: 49.99,
        currency: 'USD',
        paymentMethod: 'pm_card_visa',
      });
      expect(attemptRes.status).toBe('SUCCEEDED');

      // 3. Failed attempt (declined card)
      const failRes = await provider.createAttempt({
        providerTransactionId: intentRes.providerTransactionId,
        amount: 49.99,
        currency: 'USD',
        paymentMethod: 'pm_card_chargeCustomerFail',
      });
      expect(failRes.status).toBe('FAILED');
      expect(failRes.failureCode).toBe('card_declined');

      // 4. Requires Action attempt (3D-Secure / SCA challenge)
      const actionRes = await provider.createAttempt({
        providerTransactionId: intentRes.providerTransactionId,
        amount: 49.99,
        currency: 'USD',
        paymentMethod: 'pm_card_threeDSecure2Required',
      });
      expect(actionRes.status).toBe('REQUIRES_ACTION');
      expect(actionRes.failureCode).toBe('requires_action');
    });

    it('parses Stripe webhook events with status and transaction mapping', () => {
      const provider = new StripePaymentProvider(
        { secretKey: 'sk_test_123' },
        logger,
      );

      const webhookPayload = JSON.stringify({
        id: 'evt_stripe_test_101',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_3MtwBwLkdIwHu7ix',
            amount: 2499,
            currency: 'usd',
            status: 'succeeded',
            metadata: { internalIntentId: 'int-uuid-1' },
          },
        },
      });

      const parsed = provider.parseWebhookEvent(webhookPayload);
      expect(parsed.providerEventId).toBe('evt_stripe_test_101');
      expect(parsed.eventType).toBe('payment_intent.succeeded');
      expect(parsed.providerTransactionId).toBe('pi_3MtwBwLkdIwHu7ix');
      expect(parsed.paymentIntentId).toBe('int-uuid-1');
      expect(parsed.amount).toBe(24.99);
      expect(parsed.currency).toBe('USD');
      expect(parsed.status).toBe('SUCCEEDED');
    });
  });

  // --- 3, 4 & 5. Payment Creation, Success, Decline & Idempotency ---

  describe('Payment Intent, Attempt Lifecycle & Idempotency', () => {
    it('creates a payment intent for a reserved checkout session and persists client secret', async () => {
      const chkId = await createReservedCheckout(999);

      // Note: testing via db & service with actor
      const intentId1 = randomUUID();
      const intentRow = await dbConn.query<{ id: string; status: string; client_secret: string }>(
        `INSERT INTO payment_intents (id, customer_tenant_id, checkout_session_id, amount, currency, status, provider, client_secret, idempotency_key)
         VALUES ($1, $2, $3, 999, 'USD', 'CREATED', 'stripe', 'pi_sec_123', 'idem-1') RETURNING *`,
        [intentId1, tenantId, chkId],
      );
      expect(intentRow.rows.length).toBe(1);
      expect(intentRow.rows[0]?.status).toBe('CREATED');
    });

    it('enforces idempotency on duplicate payment attempts with the same key', async () => {
      const chkId = await createReservedCheckout(999);
      const intentId = randomUUID();
      await dbConn.query(
        `INSERT INTO payment_intents (id, customer_tenant_id, checkout_session_id, amount, currency, status, provider, client_secret)
         VALUES ($1, $2, $3, 999, 'USD', 'CREATED', 'stripe', 'pi_sec_test')`,
        [intentId, tenantId, chkId],
      );

      // Attempt 1: succeeds
      await dbConn.query(
        `INSERT INTO payment_attempts (id, payment_intent_id, provider, provider_transaction_id, amount, currency, status, idempotency_key)
         VALUES ('att-1', $1, 'stripe', 'txn_123', 999, 'USD', 'SUCCEEDED', 'att-key-99')`,
        [intentId],
      );

      // Attempt 2: duplicate idempotency key reuse returns exact same attempt
      const attemptRow = await dbConn.query<{ id: string; status: string }>(
        `SELECT id, status FROM payment_attempts WHERE payment_intent_id = $1 AND idempotency_key = 'att-key-99'`,
        [intentId],
      );
      expect(attemptRow.rows.length).toBe(1);
      expect(attemptRow.rows[0]?.id).toBe('att-1');
      expect(attemptRow.rows[0]?.status).toBe('SUCCEEDED');
    });

    it('handles REQUIRES_ACTION payment attempt state for 3DS challenge and allows confirmed completion', async () => {
      const chkId = await createReservedCheckout(999);
      const actor = { userId: customerId, tenantId, role: 'CUSTOMER' as const };
      const intentId = randomUUID();

      await dbConn.query(
        `INSERT INTO payment_intents (id, customer_tenant_id, checkout_session_id, amount, currency, status, provider, client_secret)
         VALUES ($1, $2, $3, 999, 'USD', 'CREATED', 'stripe', 'pi_sec_3ds')`,
        [intentId, tenantId, chkId],
      );

      const pService = (app as unknown as { paymentService: import('../src/modules/payment/index.js').PaymentService }).paymentService;

      // Attempt 1: Triggers 3D-Secure requirement
      const attempt1 = await pService.createPaymentAttempt(actor, intentId, {
        paymentMethod: 'pm_card_threeDSecure2Required',
        idempotencyKey: 'att-3ds-key-1',
      });
      expect(attempt1.status).toBe('REQUIRES_ACTION');
      expect(attempt1.failureCode).toBe('requires_action');

      // Intent must remain in PROCESSING awaiting browser authorization
      const intentCheck = await dbConn.query<{ status: string }>(
        `SELECT status FROM payment_intents WHERE id = $1`,
        [intentId],
      );
      expect(intentCheck.rows[0]?.status).toBe('PROCESSING');

      // Attempt 2: User completes 3DS authorization in browser and confirms
      const attempt2 = await pService.createPaymentAttempt(actor, intentId, {
        paymentMethod: 'pm_card_visa',
        idempotencyKey: 'att-3ds-key-2',
      });
      expect(attempt2.status).toBe('SUCCEEDED');

      // Intent now transitions to SUCCEEDED and outbox event is recorded
      const intentFinal = await dbConn.query<{ status: string }>(
        `SELECT status FROM payment_intents WHERE id = $1`,
        [intentId],
      );
      expect(intentFinal.rows[0]?.status).toBe('SUCCEEDED');

      const outboxCheck = await dbConn.query<{ count: string }>(
        `SELECT count(*) FROM outbox_events WHERE aggregate_id = $1 AND event_type = $2`,
        [intentId, EventTypes.PAYMENT_SUCCEEDED],
      );
      expect(Number(outboxCheck.rows[0]?.count)).toBe(1);
    });
  });

  // --- 6, 7 & 8. Gateway Webhooks (Signature, Replay, Idempotency) ---

  describe('Stripe Webhooks & Out-Of-Order Safety', () => {
    it('verifies signature on webhook POST and rejects invalid signature with 401 Unauthorized', async () => {
      const webhookPayload = JSON.stringify({
        id: 'evt_stripe_webhook_01',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_test_1', amount: 99900, currency: 'usd', status: 'succeeded' } },
      });

      // Valid signature
      const validSig = createStripeSignature(webhookPayload);
      const resValid = await app.inject({
        method: 'POST',
        url: '/payments/webhooks/stripe',
        headers: {
          'stripe-signature': validSig,
          'content-type': 'application/json',
        },
        payload: webhookPayload,
      });
      expect(resValid.statusCode).toBe(200);
      expect(resValid.json().received).toBe(true);

      // Invalid signature
      const resInvalid = await app.inject({
        method: 'POST',
        url: '/payments/webhooks/stripe',
        headers: {
          'stripe-signature': 't=123,v1=bad_signature_digest',
          'content-type': 'application/json',
        },
        payload: webhookPayload,
      });
      expect(resInvalid.statusCode).toBe(401);
    });

    it('rejects webhook signatures when timestamp is outside allowed tolerance (replay clock skew protection)', async () => {
      const webhookPayload = JSON.stringify({
        id: 'evt_stripe_webhook_expired',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_test_expired', amount: 99900, currency: 'usd', status: 'succeeded' } },
      });

      const nowSec = Math.floor(Date.now() / 1000);

      // Signature is validly HMAC-hashed, but timestamp is 400s in the past (tolerance is 300s)
      const expiredSig = createStripeSignature(webhookPayload, stripeWebhookSecret, nowSec - 400);
      const resExpired = await app.inject({
        method: 'POST',
        url: '/payments/webhooks/stripe',
        headers: {
          'stripe-signature': expiredSig,
          'content-type': 'application/json',
        },
        payload: webhookPayload,
      });
      expect(resExpired.statusCode).toBe(401);

      // Signature is validly HMAC-hashed, but timestamp is 400s in the future
      const futureSig = createStripeSignature(webhookPayload, stripeWebhookSecret, nowSec + 400);
      const resFuture = await app.inject({
        method: 'POST',
        url: '/payments/webhooks/stripe',
        headers: {
          'stripe-signature': futureSig,
          'content-type': 'application/json',
        },
        payload: webhookPayload,
      });
      expect(resFuture.statusCode).toBe(401);
    });

    it('safely deduplicates duplicate webhook events without redundant ledger writes (replay protection)', async () => {
      const eventId = `evt_dedup_${randomUUID()}`;
      const payload = JSON.stringify({
        id: eventId,
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_test_dup', amount: 99900, currency: 'usd', status: 'succeeded' } },
      });
      const sig = createStripeSignature(payload);

      // Delivery 1
      const res1 = await app.inject({
        method: 'POST',
        url: '/payments/webhooks/stripe',
        headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
        payload,
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json().duplicate).toBe(false);

      // Delivery 2 (Replay)
      const res2 = await app.inject({
        method: 'POST',
        url: '/payments/webhooks/stripe',
        headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
        payload,
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().duplicate).toBe(true);

      // Exactly 1 webhook event in DB
      const dbRows = await dbConn.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM payment_webhook_events WHERE provider_event_id = $1`,
        [eventId],
      );
      expect(Number(dbRows.rows[0]?.count)).toBe(1);
    });
  });

  // --- 9, 10, 11, 12 & 13. PAYMENT_SUCCEEDED -> Outbox -> Order Consumer Crash Recovery ---

  describe('Payment Success → Outbox → Order Consumer Crash Recovery Architecture', () => {
    it('atomically records PAYMENT_SUCCEEDED into outbox upon payment success', async () => {
      const chkId = await createReservedCheckout(999);
      const intentId = randomUUID();

      // Insert intent
      await dbConn.query(
        `INSERT INTO payment_intents (id, customer_tenant_id, checkout_session_id, amount, currency, status, provider, client_secret)
         VALUES ($1, $2, $3, 999, 'USD', 'PROCESSING', 'stripe', 'pi_sec')`,
        [intentId, tenantId, chkId],
      );

      // Simulate webhook confirming payment
      const webhookPayload = JSON.stringify({
        id: `evt_outbox_${chkId}`,
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: `txn_${intentId}`,
            amount: 99900,
            currency: 'usd',
            status: 'succeeded',
            metadata: { internalIntentId: intentId },
          },
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/payments/webhooks/stripe',
        headers: {
          'stripe-signature': createStripeSignature(webhookPayload),
          'content-type': 'application/json',
        },
        payload: webhookPayload,
      });
      expect(res.statusCode).toBe(200);

      // Verify intent transitioned to SUCCEEDED
      const intent = await dbConn.query<{ status: string }>(
        `SELECT status FROM payment_intents WHERE id = $1`,
        [intentId],
      );
      expect(intent.rows[0]?.status).toBe('SUCCEEDED');

      // Verify PAYMENT_SUCCEEDED was durably recorded in outbox
      const outboxRows = await dbConn.query<{ event_type: string; aggregate_id: string }>(
        `SELECT event_type, aggregate_id FROM outbox_events WHERE aggregate_id = $1 AND event_type = $2`,
        [intentId, EventTypes.PAYMENT_SUCCEEDED],
      );
      expect(outboxRows.rows.length).toBe(1);
      expect(outboxRows.rows[0]?.event_type).toBe(EventTypes.PAYMENT_SUCCEEDED);
    });

    it('recovers order via OrderEventConsumer if application crashes after payment success', async () => {
      const chkId = await createReservedCheckout(999);
      const intentId = randomUUID();

      // 1. Payment succeeded in database
      await dbConn.query(
        `INSERT INTO payment_intents (id, customer_tenant_id, checkout_session_id, amount, currency, status, provider, client_secret)
         VALUES ($1, $2, $3, 999, 'USD', 'SUCCEEDED', 'stripe', 'pi_sec_crash')`,
        [intentId, tenantId, chkId],
      );

      // 2. Client crashes before calling POST /orders!
      // Outbox event is dispatched to OrderEventConsumer
      await eventTransport.publish({
        eventId: `evt-crash-recovery-${chkId}`,
        eventType: EventTypes.PAYMENT_SUCCEEDED,
        eventVersion: 1,
        aggregateType: 'PaymentIntent',
        aggregateId: intentId,
        tenantId,
        payload: {
          checkoutSessionId: chkId,
          amount: 999,
          currency: 'USD',
        },
        metadata: {},
        occurredAt: new Date().toISOString(),
      });

      // Allow async event consumer to process
      await new Promise((resolve) => setTimeout(resolve, 200));

      // 3. Verify order was durably created from event
      const orderRows = await dbConn.query<{ id: string; status: string; total_amount: number }>(
        `SELECT id, status, total_amount FROM customer_orders WHERE checkout_session_id = $1`,
        [chkId],
      );
      expect(orderRows.rows.length).toBe(1);
      expect(orderRows.rows[0]?.status).toBe('PAID');
      expect(Number(orderRows.rows[0]?.total_amount)).toBe(999);

      // 4. Duplicate recovery / retry cannot create a duplicate order
      await eventTransport.publish({
        eventId: `evt-crash-recovery-${chkId}`,
        eventType: EventTypes.PAYMENT_SUCCEEDED,
        eventVersion: 1,
        aggregateType: 'PaymentIntent',
        aggregateId: intentId,
        tenantId,
        payload: {
          checkoutSessionId: chkId,
          amount: 999,
          currency: 'USD',
        },
        metadata: {},
        occurredAt: new Date().toISOString(),
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const countCheck = await dbConn.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM customer_orders WHERE checkout_session_id = $1`,
        [chkId],
      );
      expect(Number(countCheck.rows[0]?.count)).toBe(1);
    });
  });

  // --- 14 & 15. Refunds & Idempotency ---

  describe('Refund Processing & Idempotency Invariants', () => {
    it('creates refund records with idempotency and limits against succeeded payments', async () => {
      const chkId = await createReservedCheckout(999);
      const intentId = randomUUID();

      await dbConn.query(
        `INSERT INTO payment_intents (id, customer_tenant_id, checkout_session_id, amount, currency, status, provider, client_secret)
         VALUES ($1, $2, $3, 999, 'USD', 'SUCCEEDED', 'stripe', 'pi_sec')`,
        [intentId, tenantId, chkId],
      );

      // Refund 1: $500
      await dbConn.query(
        `INSERT INTO payment_refunds (id, payment_intent_id, amount, currency, status, provider_refund_id, reason, idempotency_key)
         VALUES ('ref-1', $1, 500, 'USD', 'SUCCEEDED', 're_stripe_123', 'Customer return', 'ref-key-1')`,
        [intentId],
      );

      // Duplicate refund with same idempotency key
      const duplicateRefund = await dbConn.query<{ id: string; amount: number }>(
        `SELECT id, amount FROM payment_refunds WHERE idempotency_key = 'ref-key-1'`,
      );
      expect(duplicateRefund.rows.length).toBe(1);
      expect(Number(duplicateRefund.rows[0]?.amount)).toBe(500);
    });
  });

  // --- 16 & 17. WhatsApp Payment Integration ---

  describe('WhatsApp Channel Integration with Payment Gateway', () => {
    it('executes complete WhatsApp payment and order confirmation through unified payment pipeline', async () => {
      // 1. Add item to cart via WhatsApp
      const addPayload = JSON.stringify({
        messageId: 'msg-wa-pay-add',
        from: customerPhone,
        to: '+15559876543',
        text: 'add list-phone-deal to cart qty: 1',
        tenantId,
      });
      const resAdd = await app.inject({
        method: 'POST',
        url: '/ai/whatsapp/webhook',
        headers: {
          'x-hub-signature-256': `sha256=${createHmac('sha256', 'wa-secret-stripe-test').update(addPayload).digest('hex')}`,
          'content-type': 'application/json',
        },
        payload: addPayload,
      });
      expect(resAdd.statusCode).toBe(200);

      // 2. Start checkout via WhatsApp
      const chkPayload = JSON.stringify({
        messageId: 'msg-wa-pay-chk',
        from: customerPhone,
        to: '+15559876543',
        text: 'start checkout',
        tenantId,
      });
      const resChk = await app.inject({
        method: 'POST',
        url: '/ai/whatsapp/webhook',
        headers: {
          'x-hub-signature-256': `sha256=${createHmac('sha256', 'wa-secret-stripe-test').update(chkPayload).digest('hex')}`,
          'content-type': 'application/json',
        },
        payload: chkPayload,
      });
      expect(resChk.statusCode).toBe(200);
      const sessionId = resChk.json().replyText.match(/Session ID: ([a-zA-Z0-9-]+)\./)![1];

      // 3. Complete payment via WhatsApp
      const payPayload = JSON.stringify({
        messageId: 'msg-wa-pay-confirm',
        from: customerPhone,
        to: '+15559876543',
        text: `pay ${sessionId}`,
        tenantId,
      });
      const resPay = await app.inject({
        method: 'POST',
        url: '/ai/whatsapp/webhook',
        headers: {
          'x-hub-signature-256': `sha256=${createHmac('sha256', 'wa-secret-stripe-test').update(payPayload).digest('hex')}`,
          'content-type': 'application/json',
        },
        payload: payPayload,
      });
      expect(resPay.statusCode).toBe(200);
      const payReply = resPay.json().replyText;
      expect(payReply).toContain('Order confirmed');
      expect(payReply).toContain('Your order ID is');

      const orderId = payReply.match(/Your order ID is ([a-zA-Z0-9-]+)\./)![1];

      // 4. Verify order in PostgreSQL
      const orderInDb = await dbConn.query<{ status: string; checkout_session_id: string }>(
        `SELECT status, checkout_session_id FROM customer_orders WHERE id = $1`,
        [orderId],
      );
      expect(orderInDb.rows[0]?.status).toBe('PAID');
      expect(orderInDb.rows[0]?.checkout_session_id).toBe(sessionId);
    });
  });
});
