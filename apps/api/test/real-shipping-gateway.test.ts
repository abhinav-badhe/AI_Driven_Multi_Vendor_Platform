import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig, type AppConfig } from '../src/config/index.js';
import {
  createMigratedTestDatabase,
  markAllUsersVerified,
  registerVerifiedUser,
} from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';
import { InMemoryEventTransport, EventTypes } from '../src/modules/events/index.js';
import { InMemorySearchStore } from '../src/modules/search/index.js';
import { JsonLogger } from '../src/observability/logger.js';
import {
  ShippoCarrierProvider,
  mapShippoStatus,
  type ProviderCreateShipmentInput,
  FulfillmentRepository,
} from '../src/modules/fulfillment/index.js';

describe('Real Shipping Gateway (Shippo Sandbox) Integration & Architecture', () => {
  let app: FastifyInstance;
  let db: DatabaseConnection;
  let eventTransport: InMemoryEventTransport;
  let searchStore: InMemorySearchStore;
  let realShippoProvider: ShippoCarrierProvider;
  const logger = new JsonLogger({
    serviceName: 'shipping-test',
    level: 'error',
    pretty: false,
    redactKeys: [],
  });

  const shippoApiKey = 'shippo_test_1234567890abcdef';
  const shippoWebhookSecret = 'whsec_shippo_test_signing_secret_999';

  // In-memory simulation of Shippo Sandbox REST API
  const simulatedShippoStore = new Map<string, Record<string, unknown>>();
  const simulatedIdempotencyStore = new Map<string, Record<string, unknown>>();
  let shippoApiCallCount = 0;

  const mockShippoFetch: typeof fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    shippoApiCallCount++;
    const urlStr = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const bodyStr = init?.body ? String(init.body) : '';
    let parsedBody: Record<string, unknown> = {};
    if (bodyStr) {
      try {
        parsedBody = JSON.parse(bodyStr);
      } catch {
        // empty
      }
    }

    const rawHeaders = init?.headers;
    let idempotencyKeyHeader: string | undefined;
    if (rawHeaders) {
      if (typeof (rawHeaders as Headers).get === 'function') {
        idempotencyKeyHeader =
          (rawHeaders as Headers).get('Idempotency-Key') ??
          (rawHeaders as Headers).get('idempotency-key') ??
          undefined;
      } else if (typeof rawHeaders === 'object') {
        idempotencyKeyHeader =
          (rawHeaders as Record<string, string>)['Idempotency-Key'] ??
          (rawHeaders as Record<string, string>)['idempotency-key'];
      }
    }

    // 1. POST /shipments
    if (urlStr.endsWith('/shipments') && method === 'POST') {
      if (idempotencyKeyHeader && simulatedIdempotencyStore.has(idempotencyKeyHeader)) {
        return new Response(JSON.stringify(simulatedIdempotencyStore.get(idempotencyKeyHeader)!), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const shipmentId = `shp_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const rateId = `rate_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const isReturn = Boolean(
        (parsedBody['extra'] as Record<string, unknown> | undefined)?.['is_return'],
      );

      const shipmentRecord = {
        object_id: shipmentId,
        status: 'SUCCESS',
        rates: [
          {
            object_id: rateId,
            provider: 'USPS',
            servicelevel: { token: 'usps_priority', name: 'Priority Mail' },
            amount: isReturn ? '8.50' : '12.50',
            currency: 'USD',
          },
          {
            object_id: `rate_fedex_${randomUUID().slice(0, 8)}`,
            provider: 'FedEx',
            servicelevel: { token: 'fedex_ground', name: 'FedEx Ground' },
            amount: '15.00',
            currency: 'USD',
          },
        ],
        metadata: parsedBody['metadata'],
      };
      simulatedShippoStore.set(shipmentId, shipmentRecord);
      if (idempotencyKeyHeader) {
        simulatedIdempotencyStore.set(idempotencyKeyHeader, shipmentRecord);
      }
      return new Response(JSON.stringify(shipmentRecord), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. POST /transactions (purchase label)
    if (urlStr.endsWith('/transactions') && method === 'POST') {
      if (idempotencyKeyHeader && simulatedIdempotencyStore.has(idempotencyKeyHeader)) {
        return new Response(JSON.stringify(simulatedIdempotencyStore.get(idempotencyKeyHeader)!), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const txId = `tx_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const trackingNumber = `940011189956254${Math.floor(100000 + Math.random() * 900000)}`;

      const txRecord = {
        object_id: txId,
        status: 'SUCCESS',
        rate: parsedBody['rate'],
        tracking_number: trackingNumber,
        tracking_url_provider: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
        label_url: `https://delivery.goshippo.com/labels/${txId}.pdf`,
        eta: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
        test: true,
        metadata: parsedBody['metadata'],
      };
      simulatedShippoStore.set(txId, txRecord);
      if (idempotencyKeyHeader) {
        simulatedIdempotencyStore.set(idempotencyKeyHeader, txRecord);
      }
      return new Response(JSON.stringify(txRecord), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. GET /tracks/:carrier/:trackingNumber
    if (urlStr.includes('/tracks/')) {
      const parts = urlStr.split('/tracks/')[1]!.split('/');
      const carrier = parts[0] || 'usps';
      const trackingNumber = decodeURIComponent(parts[1] || 'default');

      const trackRecord = {
        carrier,
        tracking_number: trackingNumber,
        tracking_status: {
          status: 'TRANSIT',
          status_details: 'Package has departed the distribution center',
          status_date: new Date().toISOString(),
          location: {
            city: 'San Francisco',
            state: 'CA',
            zip: '94105',
            country: 'US',
          },
        },
      };
      return new Response(JSON.stringify(trackRecord), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 4. POST /refunds
    if (urlStr.endsWith('/refunds') && method === 'POST') {
      const refundId = `ref_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const refundRecord = {
        object_id: refundId,
        status: 'SUCCESS',
        transaction: parsedBody['transaction'],
      };
      return new Response(JSON.stringify(refundRecord), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Endpoint not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const createShippoWebhookSignature = (
    rawPayload: string,
    secret = shippoWebhookSecret,
    timestamp = Math.floor(Date.now() / 1000),
  ): string => {
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${rawPayload}`)
      .digest('hex');
    return `t=${timestamp},v1=${signature}`;
  };

  function getTestConfig(): AppConfig {
    return parseConfig({
      NODE_ENV: 'test',
      PORT: '0',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'fatal',
      DATABASE_HOST: 'localhost',
      DATABASE_PORT: '5432',
      DATABASE_NAME: 'commerce_shipping_test',
      DATABASE_USER: 'test_user',
      DATABASE_PASSWORD: 'test_password',
      DATABASE_POOL_MIN: '1',
      DATABASE_POOL_MAX: '5',
      REDIS_HOST: 'localhost',
      REDIS_PORT: '6379',
      REDIS_TLS: 'false',
      ACCESS_TOKEN_SECRET: 'super-secret-key-at-least-16-chars',
      SERVICE_NAME: 'shipping-test-api',
      LOG_PRETTY: 'false',
      REDACT_KEYS: 'password,token',
      CARRIER_PROVIDER: 'shippo',
      SHIPPO_API_KEY: shippoApiKey,
      SHIPPO_WEBHOOK_SECRET: shippoWebhookSecret,
      SHIPPO_BASE_URL: 'https://api.goshippo.com',
      SHIPPO_TIMEOUT_MS: '10000',
      SHIPPO_WEBHOOK_TOLERANCE_SECONDS: '300',
    });
  }

  beforeEach(async () => {
    db = await createMigratedTestDatabase();
    eventTransport = new InMemoryEventTransport();
    searchStore = new InMemorySearchStore();
    simulatedShippoStore.clear();
    simulatedIdempotencyStore.clear();
    shippoApiCallCount = 0;

    const config = getTestConfig();

    realShippoProvider = new ShippoCarrierProvider(
      {
        apiKey: shippoApiKey,
        baseUrl: 'https://api.goshippo.com',
        webhookSecret: shippoWebhookSecret,
        timeoutMs: 10000,
        webhookToleranceSeconds: 300,
        fetchFn: mockShippoFetch,
      },
      logger,
    );

    app = await buildApp({
      config,
      logger,
      searchStore,
      eventTransport,
      carrierProvider: realShippoProvider,
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

    // 4. Products & Stock
    const cat = (
      await app.inject({
        method: 'POST',
        url: '/categories',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Hardware', slug: 'hardware' },
      })
    ).json();

    const prodA = (
      await app.inject({
        method: 'POST',
        url: '/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          title: 'Shippo Router Pro',
          slug: 'shippo-router-pro',
          brand: 'AlphaBrand',
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
        payload: { skuCode: 'SKU-SHIPPO-01', attributes: { color: 'Blue' } },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/skus/${skuA.id}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'ACTIVE' },
    });

    const listA = (
      await app.inject({
        method: 'POST',
        url: '/listings',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { skuId: skuA.id, priceAmount: 4999, currency: 'USD' },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/listings/${listA.id}/status`,
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { status: 'ACTIVE' },
    });

    await app.inject({
      method: 'POST',
      url: '/inventory',
      headers: { authorization: `Bearer ${alphaToken}` },
      payload: { listingId: listA.id, skuId: skuA.id, initialOnHandQuantity: 25 },
    });

    // Customer
    const custToken = await registerVerifiedUser(app, db, {
      email: 'customer@buyer.com',
      password: 'Password123!',
      tenantName: 'Customer Tenant',
      role: 'CUSTOMER',
    });

    return { adminToken, alphaToken, betaToken, custToken, profA, profB, listA };
  }

  async function createPaidOrder(eco: Awaited<ReturnType<typeof setupEcosystem>>, quantity = 2) {
    await app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { authorization: `Bearer ${eco.custToken}` },
      payload: { listingId: eco.listA.id, quantity },
    });

    const session = (
      await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { authorization: `Bearer ${eco.custToken}` },
      })
    ).json();

    await app.inject({
      method: 'POST',
      url: `/checkout/sessions/${session.id}/reserve`,
      headers: { authorization: `Bearer ${eco.custToken}` },
    });

    const intent = (
      await app.inject({
        method: 'POST',
        url: '/payments/intents',
        headers: { authorization: `Bearer ${eco.custToken}` },
        payload: { checkoutSessionId: session.id },
      })
    ).json();

    await app.inject({
      method: 'POST',
      url: `/payments/intents/${intent.id}/attempts`,
      headers: { authorization: `Bearer ${eco.custToken}` },
      payload: { paymentMethod: 'pm_card_visa' },
    });

    const orderRes = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: `Bearer ${eco.custToken}` },
      payload: { checkoutSessionId: session.id, paymentIntentId: intent.id },
    });
    expect(orderRes.statusCode).toBe(201);
    const order = orderRes.json();
    const sellerOrder = order.sellerOrders[0];
    const orderItem = sellerOrder.items[0];

    return { order, sellerOrder, orderItem, intent };
  }

  // --- 1. REAL CARRIER ADAPTER UNIT TESTS ---
  describe('1. Real Carrier Adapter (Shippo Sandbox Provider)', () => {
    it('creates shipment with rate fetching and label generation', async () => {
      const provider = new ShippoCarrierProvider(
        { apiKey: shippoApiKey, webhookSecret: shippoWebhookSecret, fetchFn: mockShippoFetch },
        logger,
      );

      const input: ProviderCreateShipmentInput = {
        sellerOrderId: 'so_test_123',
        customerOrderId: 'co_test_456',
        senderAddress: {
          name: 'Alpha Warehouse',
          street1: '100 Mission St',
          city: 'San Francisco',
          state: 'CA',
          postalCode: '94105',
          country: 'US',
        },
        recipientAddress: {
          name: 'Abhinav Buyer',
          street1: '500 Market St',
          city: 'San Francisco',
          state: 'CA',
          postalCode: '94105',
          country: 'US',
        },
        items: [{ orderItemId: 'item_1', productTitle: 'Router', quantity: 1, unitPrice: 4999 }],
        carrier: 'USPS',
        idempotencyKey: 'idemp_provider_test_1',
      };

      const res = await provider.createShipment(input);
      expect(res.carrierShipmentId).toMatch(/^tx_/);
      expect(res.carrier).toBe('USPS');
      expect(res.trackingNumber).toMatch(/^9400/);
      expect(res.labelUrl).toContain('.pdf');
      expect(res.status).toBe('READY_TO_SHIP');
      expect(res.metadata?.['provider']).toBe('shippo');

      // Idempotency within provider ledger
      const res2 = await provider.createShipment(input);
      expect(res2.carrierShipmentId).toBe(res.carrierShipmentId);
      expect(res2.trackingNumber).toBe(res.trackingNumber);
    });

    it('queries live tracking telemetry from provider', async () => {
      const provider = new ShippoCarrierProvider(
        { apiKey: shippoApiKey, fetchFn: mockShippoFetch },
        logger,
      );

      const tracking = await provider.getTracking('USPS', '940011189956254123456');
      expect(tracking.carrier).toBe('USPS');
      expect(tracking.trackingNumber).toBe('940011189956254123456');
      expect(tracking.status).toBe('IN_TRANSIT');
      expect(tracking.location).toContain('San Francisco');
    });

    it('requests cancellation/refund with carrier', async () => {
      const provider = new ShippoCarrierProvider(
        { apiKey: shippoApiKey, fetchFn: mockShippoFetch },
        logger,
      );

      const cancelRes = await provider.cancelShipment('tx_test_to_cancel');
      expect(cancelRes.cancelled).toBe(true);
      expect(cancelRes.carrierShipmentId).toBe('tx_test_to_cancel');
    });

    it('creates return shipment with return flag', async () => {
      const provider = new ShippoCarrierProvider(
        { apiKey: shippoApiKey, fetchFn: mockShippoFetch },
        logger,
      );

      const retRes = await provider.createReturnShipment({
        returnId: 'ret_test_123',
        sellerOrderId: 'so_test_123',
        customerOrderId: 'co_test_456',
        senderAddress: {
          name: 'Customer',
          street1: 'Home',
          city: 'SF',
          state: 'CA',
          postalCode: '94105',
          country: 'US',
        },
        recipientAddress: {
          name: 'Merchant',
          street1: 'Store',
          city: 'SF',
          state: 'CA',
          postalCode: '94105',
          country: 'US',
        },
        items: [{ orderItemId: 'item_1', quantity: 1 }],
      });

      expect(retRes.carrierShipmentId).toMatch(/^tx_/);
      expect(retRes.trackingNumber).toBeDefined();
      expect(retRes.labelUrl).toBeDefined();
      expect(retRes.metadata?.['isReturn']).toBe(true);
    });
  });

  // --- 2. SHIPMENT CREATION FLOW & ATTRIBUTES ---
  describe('2. Real Shipment Creation through Backend API', () => {
    it('creates shipment calling carrier adapter outside DB tx, persisting label and tracking number', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 2);

      const res = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          sellerOrderId: sellerOrder.id,
          items: [{ orderItemId: orderItem.id, quantity: 2 }],
          carrier: 'USPS',
          senderAddress: {
            name: 'Alpha Warehouse',
            street1: '100 Mission St',
            city: 'San Francisco',
            state: 'CA',
            postalCode: '94105',
            country: 'US',
          },
          recipientAddress: {
            name: 'Abhinav Buyer',
            street1: '500 Market St',
            city: 'San Francisco',
            state: 'CA',
            postalCode: '94105',
            country: 'US',
          },
          idempotencyKey: 'idemp_shipment_api_1',
        },
      });

      expect(res.statusCode).toBe(201);
      const shipment = res.json();
      expect(shipment.sellerOrderId).toBe(sellerOrder.id);
      expect(shipment.sellerTenantId).toBe(eco.profA.tenantId);
      expect(shipment.carrier).toBe('USPS');
      expect(shipment.carrierShipmentId).toMatch(/^tx_/);
      expect(shipment.trackingNumber).toMatch(/^9400/);
      expect(shipment.labelUrl).toContain('.pdf');
      expect(shipment.status).toBe('READY_TO_SHIP');

      // Verify Seller Order transitioned to PROCESSING
      const soRes = await app.inject({
        method: 'GET',
        url: `/seller/orders/${sellerOrder.id}`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      });
      expect(soRes.json().status).toBe('PROCESSING');
    });
  });

  // --- 3. SHIPMENT IDEMPOTENCY ---
  describe('3. Shipment Idempotency', () => {
    it('returns existing shipment without re-calling carrier on same idempotency key', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);
      const idempotencyKey = `idemp_repeat_${randomUUID().slice(0, 8)}`;

      const payload = {
        sellerOrderId: sellerOrder.id,
        items: [{ orderItemId: orderItem.id, quantity: 1 }],
        carrier: 'USPS',
        idempotencyKey,
      };

      const res1 = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload,
      });
      expect(res1.statusCode).toBe(201);
      const ship1 = res1.json();
      const initialApiCalls = shippoApiCallCount;

      // Second request with same idempotency key
      const res2 = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload,
      });
      expect(res2.statusCode).toBe(201);
      const ship2 = res2.json();

      expect(ship2.id).toBe(ship1.id);
      expect(ship2.carrierShipmentId).toBe(ship1.carrierShipmentId);
      expect(ship2.trackingNumber).toBe(ship1.trackingNumber);
      // Carrier API was not called again
      expect(shippoApiCallCount).toBe(initialApiCalls);
    });
  });

  // --- 4. TRACKING NUMBER & LABEL PERSISTENCE ---
  describe('4. Tracking Number and Label Persistence', () => {
    it('persists carrier_shipment_id and label_url in shipments table', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      const res = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          sellerOrderId: sellerOrder.id,
          items: [{ orderItemId: orderItem.id, quantity: 1 }],
          carrier: 'USPS',
        },
      });
      const shipment = res.json();

      const dbRows = await db.query<{
        carrier_shipment_id: string;
        label_url: string;
        tracking_number: string;
      }>(`SELECT carrier_shipment_id, label_url, tracking_number FROM shipments WHERE id = $1`, [
        shipment.id,
      ]);

      expect(dbRows.rows).toHaveLength(1);
      expect(dbRows.rows[0]!.carrier_shipment_id).toBe(shipment.carrierShipmentId);
      expect(dbRows.rows[0]!.label_url).toBe(shipment.labelUrl);
      expect(dbRows.rows[0]!.tracking_number).toBe(shipment.trackingNumber);
    });
  });

  // --- 5. STATUS MAPPING ---
  describe('5. Status Mapping', () => {
    it('correctly maps external carrier statuses to internal domain state machine', () => {
      expect(mapShippoStatus('DELIVERED')).toBe('DELIVERED');
      expect(mapShippoStatus('TRANSIT')).toBe('IN_TRANSIT');
      expect(mapShippoStatus('IN_TRANSIT')).toBe('IN_TRANSIT');
      expect(mapShippoStatus('OUT_FOR_DELIVERY')).toBe('OUT_FOR_DELIVERY');
      expect(mapShippoStatus('PRE_TRANSIT')).toBe('READY_TO_SHIP');
      expect(mapShippoStatus('SUCCESS')).toBe('READY_TO_SHIP');
      expect(mapShippoStatus('RETURNED')).toBe('RETURNED');
      expect(mapShippoStatus('FAILURE')).toBe('FAILED');
      expect(mapShippoStatus('ERROR')).toBe('FAILED');
      expect(mapShippoStatus('UNKNOWN_STATUS')).toBe('IN_TRANSIT');
    });
  });

  // --- 6. VALID WEBHOOK WITH SIGNATURE ---
  describe('6. Valid Webhook Processing', () => {
    it('verifies signature and transitions shipment state monotonically', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      const shipRes = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: {
            sellerOrderId: sellerOrder.id,
            items: [{ orderItemId: orderItem.id, quantity: 1 }],
          },
        })
      ).json();

      // Transition to SHIPPED first via merchant action
      await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${shipRes.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'SHIPPED' },
      });

      // Send carrier webhook for IN_TRANSIT
      const webhookPayload = JSON.stringify({
        event: 'track_updated',
        data: {
          carrier: shipRes.carrier,
          tracking_number: shipRes.trackingNumber,
          tracking_status: {
            status: 'TRANSIT',
            status_details: 'In transit to destination',
            status_date: new Date().toISOString(),
            location: { city: 'Oakland', state: 'CA', country: 'US' },
          },
        },
      });
      const signatureHeader = createShippoWebhookSignature(webhookPayload);

      const callbackRes = await app.inject({
        method: 'POST',
        url: '/fulfillment/carrier/callback',
        headers: {
          'Content-Type': 'application/json',
          'shippo-signature': signatureHeader,
        },
        payload: webhookPayload,
      });

      expect(callbackRes.statusCode).toBe(200);
      expect(callbackRes.json().status).toBe('IN_TRANSIT');

      // Verify shipment in DB is now IN_TRANSIT
      const updatedShipment = (
        await app.inject({
          method: 'GET',
          url: `/fulfillment/shipments/${shipRes.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(updatedShipment.status).toBe('IN_TRANSIT');
    });
  });

  // --- 7. INVALID WEBHOOK SIGNATURE ---
  describe('7. Invalid Webhook Signature Rejection', () => {
    it('rejects forged webhook with 401 Unauthorized', async () => {
      const webhookPayload = JSON.stringify({
        carrier: 'USPS',
        tracking_number: '940011189956254123456',
        status: 'DELIVERED',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/fulfillment/carrier/callback',
        headers: {
          'Content-Type': 'application/json',
          'shippo-signature': 't=123456789,v1=bad_hex_signature_forged',
        },
        payload: webhookPayload,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // --- 8. WEBHOOK TIMESTAMP SKEW / REPLAY TOLERANCE ---
  describe('8. Webhook Timestamp Replay Tolerance', () => {
    it('rejects webhook when timestamp is skewed beyond tolerance window (>300s)', async () => {
      const webhookPayload = JSON.stringify({
        carrier: 'USPS',
        tracking_number: '940011189956254123456',
        status: 'DELIVERED',
      });

      // Timestamp from 10 minutes ago
      const expiredTimestamp = Math.floor(Date.now() / 1000) - 600;
      const expiredSig = createShippoWebhookSignature(
        webhookPayload,
        shippoWebhookSecret,
        expiredTimestamp,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/fulfillment/carrier/callback',
        headers: {
          'Content-Type': 'application/json',
          'shippo-signature': expiredSig,
        },
        payload: webhookPayload,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // --- 9. DUPLICATE WEBHOOK DEDUPLICATION ---
  describe('9. Duplicate Webhook Deduplication', () => {
    it('safely deduplicates identical webhook deliveries without repeating state changes', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      const shipRes = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: {
            sellerOrderId: sellerOrder.id,
            items: [{ orderItemId: orderItem.id, quantity: 1 }],
          },
        })
      ).json();

      await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${shipRes.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'SHIPPED' },
      });

      const eventId = `evt_shippo_${randomUUID().slice(0, 8)}`;
      const webhookPayload = JSON.stringify({
        event: 'track_updated',
        event_id: eventId,
        data: {
          carrier: shipRes.carrier,
          tracking_number: shipRes.trackingNumber,
          tracking_status: { status: 'TRANSIT', status_date: new Date().toISOString() },
        },
      });
      const sig = createShippoWebhookSignature(webhookPayload);

      // Delivery 1
      const res1 = await app.inject({
        method: 'POST',
        url: '/fulfillment/carrier/callback',
        headers: { 'Content-Type': 'application/json', 'shippo-signature': sig },
        payload: webhookPayload,
      });
      expect(res1.statusCode).toBe(200);

      // Delivery 2 (Replay / Duplicate)
      const res2 = await app.inject({
        method: 'POST',
        url: '/fulfillment/carrier/callback',
        headers: { 'Content-Type': 'application/json', 'shippo-signature': sig },
        payload: webhookPayload,
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().deduplicated).toBe(true);

      // Verify exactly 1 carrier_webhook_events record in database
      const countRes = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM carrier_webhook_events WHERE carrier = $1 AND provider_event_id = $2`,
        [shipRes.carrier, eventId],
      );
      expect(Number(countRes.rows[0]!.count)).toBe(1);
    });
  });

  // --- 10. OUT-OF-ORDER WEBHOOK MONOTONICITY ---
  describe('10. Out-of-Order Webhook Monotonicity', () => {
    it('prevents an out-of-order PRE_TRANSIT or SHIPPED webhook from regressing a DELIVERED shipment', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      const shipRes = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: {
            sellerOrderId: sellerOrder.id,
            items: [{ orderItemId: orderItem.id, quantity: 1 }],
          },
        })
      ).json();

      // Transition through to DELIVERED
      await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${shipRes.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'SHIPPED' },
      });
      await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${shipRes.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'IN_TRANSIT' },
      });
      await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${shipRes.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'OUT_FOR_DELIVERY' },
      });
      await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${shipRes.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'DELIVERED' },
      });

      // Out-of-order webhook arrives with older "SHIPPED" status
      const outOfOrderPayload = JSON.stringify({
        event: 'track_updated',
        event_id: `evt_old_${randomUUID().slice(0, 8)}`,
        data: {
          carrier: shipRes.carrier,
          tracking_number: shipRes.trackingNumber,
          tracking_status: { status: 'PRE_TRANSIT', status_date: new Date().toISOString() },
        },
      });
      const sig = createShippoWebhookSignature(outOfOrderPayload);

      const res = await app.inject({
        method: 'POST',
        url: '/fulfillment/carrier/callback',
        headers: { 'Content-Type': 'application/json', 'shippo-signature': sig },
        payload: outOfOrderPayload,
      });

      expect(res.statusCode).toBe(200);
      // Status remained DELIVERED (no regression)
      expect(res.json().status).toBe('DELIVERED');

      const checkShip = (
        await app.inject({
          method: 'GET',
          url: `/fulfillment/shipments/${shipRes.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(checkShip.status).toBe('DELIVERED');
    });
  });

  // --- 11 & 12. CARRIER SUCCEEDS + DB TRANSACTION FAILS / SAFE RETRY RECONCILIATION ---
  // --- 11 & 12. CARRIER SUCCEEDS + DB TRANSACTION FAILS / SAFE RETRY RECONCILIATION ---
  describe('11 & 12. Carrier Succeeds + DB Fails & Safe Retry Reconciliation', () => {
    it('reconciles carrier shipment on retry with stable idempotency key without duplicate postage', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);
      const idempotencyKey = `idemp_db_fail_test_${randomUUID().slice(0, 8)}`;

      // 1. Simulate carrier call succeeds using active carrier provider with stable key
      const initialShipmentResult = await realShippoProvider.createShipment({
        sellerOrderId: sellerOrder.id,
        customerOrderId: sellerOrder.customerOrderId,
        senderAddress: {
          name: 'Alpha',
          street1: '100 Mission St',
          city: 'SF',
          state: 'CA',
          postalCode: '94105',
          country: 'US',
        },
        recipientAddress: {
          name: 'Customer',
          street1: '500 Market St',
          city: 'SF',
          state: 'CA',
          postalCode: '94105',
          country: 'US',
        },
        items: [{ orderItemId: orderItem.id, quantity: 1 }],
        carrier: 'USPS',
        idempotencyKey,
      });

      // Durably record the carrier operation in PostgreSQL
      const carrierKey = `${sellerOrder.sellerTenantId}:${idempotencyKey}`;
      await db.query(
        `INSERT INTO carrier_shipment_operations (
          idempotency_key, seller_order_id, seller_tenant_id, carrier, carrier_shipment_id,
          tracking_number, tracking_url, label_url, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'COMPLETED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          carrierKey,
          sellerOrder.id,
          sellerOrder.sellerTenantId,
          'USPS',
          initialShipmentResult.carrierShipmentId,
          initialShipmentResult.trackingNumber,
          initialShipmentResult.trackingUrl,
          initialShipmentResult.labelUrl,
        ],
      );

      const initialApiCalls = shippoApiCallCount;
      expect(initialShipmentResult.carrierShipmentId).toBeDefined();

      // Wipe all in-memory caches to prove recovery relies purely on durable PostgreSQL
      realShippoProvider.clearIdempotencyLedger();

      // 2. Now simulate the retry request through the backend API with the SAME idempotency key
      const retryRes = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          sellerOrderId: sellerOrder.id,
          items: [{ orderItemId: orderItem.id, quantity: 1 }],
          carrier: 'USPS',
          idempotencyKey,
        },
      });

      expect(retryRes.statusCode).toBe(201);
      const persistedShipment = retryRes.json();

      // Proves: Reconciled with the existing carrier shipment rather than creating a duplicate
      expect(persistedShipment.carrierShipmentId).toBe(initialShipmentResult.carrierShipmentId);
      expect(persistedShipment.trackingNumber).toBe(initialShipmentResult.trackingNumber);
      // No duplicate carrier transactions created
      expect(shippoApiCallCount).toBe(initialApiCalls);
    });

    it('recovers after complete application restart before retry via durable PostgreSQL records', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);
      const idempotencyKey = `idemp_restart_${randomUUID().slice(0, 8)}`;

      // Initial carrier shipment created
      const initialShipmentResult = await realShippoProvider.createShipment({
        sellerOrderId: sellerOrder.id,
        customerOrderId: sellerOrder.customerOrderId,
        senderAddress: {
          name: 'Alpha',
          street1: '100 Mission St',
          city: 'SF',
          state: 'CA',
          postalCode: '94105',
          country: 'US',
        },
        recipientAddress: {
          name: 'Customer',
          street1: '500 Market St',
          city: 'SF',
          state: 'CA',
          postalCode: '94105',
          country: 'US',
        },
        items: [{ orderItemId: orderItem.id, quantity: 1 }],
        carrier: 'USPS',
        idempotencyKey,
      });

      // Durably record in carrier_shipment_operations in PostgreSQL
      const restartCarrierKey = `${sellerOrder.sellerTenantId}:${idempotencyKey}`;
      await db.query(
        `INSERT INTO carrier_shipment_operations (
          idempotency_key, seller_order_id, seller_tenant_id, carrier, carrier_shipment_id,
          tracking_number, tracking_url, label_url, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'COMPLETED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          restartCarrierKey,
          sellerOrder.id,
          sellerOrder.sellerTenantId,
          'USPS',
          initialShipmentResult.carrierShipmentId,
          initialShipmentResult.trackingNumber,
          initialShipmentResult.trackingUrl,
          initialShipmentResult.labelUrl,
        ],
      );

      const callsBeforeRestart = shippoApiCallCount;

      // Simulate full process crash and application restart:
      // Create a brand new independent ShippoCarrierProvider and FastifyInstance sharing the SAME PostgreSQL db
      const newProvider = new ShippoCarrierProvider(
        {
          apiKey: shippoApiKey,
          baseUrl: 'https://api.goshippo.com',
          webhookSecret: shippoWebhookSecret,
          timeoutMs: 10000,
          webhookToleranceSeconds: 300,
          fetchFn: mockShippoFetch,
        },
        logger,
      );

      const restartedApp = await buildApp({
        config: getTestConfig(),
        logger,
        searchStore: new InMemorySearchStore(),
        eventTransport: new InMemoryEventTransport(),
        carrierProvider: newProvider,
        dbConnection: db,
        skipMigrations: true,
      });
      await restartedApp.ready();

      // Retry sent to the newly restarted application
      const retryRes = await restartedApp.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          sellerOrderId: sellerOrder.id,
          items: [{ orderItemId: orderItem.id, quantity: 1 }],
          carrier: 'USPS',
          idempotencyKey,
        },
      });

      expect(retryRes.statusCode).toBe(201);
      const recoveredShipment = retryRes.json();
      expect(recoveredShipment.carrierShipmentId).toBe(initialShipmentResult.carrierShipmentId);
      expect(recoveredShipment.trackingNumber).toBe(initialShipmentResult.trackingNumber);

      // Proves: ZERO external carrier calls made by the new application process on retry
      expect(shippoApiCallCount).toBe(callsBeforeRestart);

      await restartedApp.close();
    });

    it('proves two concurrent requests across multiple API instances sharing PostgreSQL cannot create duplicate carrier shipments', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);
      const idempotencyKey = `idemp_concurrent_${randomUUID().slice(0, 8)}`;

      // Simulate two separate API server instances sharing the exact same PostgreSQL database
      const providerInstance1 = new ShippoCarrierProvider(
        { apiKey: shippoApiKey, baseUrl: 'https://api.goshippo.com', fetchFn: mockShippoFetch },
        logger,
      );
      const providerInstance2 = new ShippoCarrierProvider(
        { apiKey: shippoApiKey, baseUrl: 'https://api.goshippo.com', fetchFn: mockShippoFetch },
        logger,
      );

      const appInstance1 = await buildApp({
        config: getTestConfig(),
        logger,
        searchStore: new InMemorySearchStore(),
        eventTransport: new InMemoryEventTransport(),
        carrierProvider: providerInstance1,
        dbConnection: db,
        skipMigrations: true,
      });
      const appInstance2 = await buildApp({
        config: getTestConfig(),
        logger,
        searchStore: new InMemorySearchStore(),
        eventTransport: new InMemoryEventTransport(),
        carrierProvider: providerInstance2,
        dbConnection: db,
        skipMigrations: true,
      });

      await appInstance1.ready();
      await appInstance2.ready();

      const callsBefore = shippoApiCallCount;

      // Send concurrent requests to both API instances simultaneously
      const [res1, res2] = await Promise.all([
        appInstance1.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: {
            sellerOrderId: sellerOrder.id,
            items: [{ orderItemId: orderItem.id, quantity: 1 }],
            carrier: 'USPS',
            idempotencyKey,
          },
        }),
        appInstance2.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: {
            sellerOrderId: sellerOrder.id,
            items: [{ orderItemId: orderItem.id, quantity: 1 }],
            carrier: 'USPS',
            idempotencyKey,
          },
        }),
      ]);

      // Both instances must complete gracefully (either 201 created or 201 reconciled)
      expect([201, 409]).toContain(res1.statusCode);
      expect([201, 409]).toContain(res2.statusCode);
      expect(res1.statusCode === 201 || res2.statusCode === 201).toBe(true);

      // Verify PostgreSQL database state: exactly ONE shipment exists for this seller order
      const dbShipments = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM shipments WHERE seller_order_id = $1`,
        [sellerOrder.id],
      );
      expect(Number(dbShipments.rows[0]!.count)).toBe(1);

      // Verify only ONE carrier shipment (2 API calls: /shipments and /transactions) was made across both instances
      expect(shippoApiCallCount - callsBefore).toBe(2);

      await appInstance1.close();
      await appInstance2.close();
    });

    it('recovers when process crashes after operation claim but before carrier HTTP call via stale lease expiration', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);
      const idempotencyKey = `idemp_claim_crash_${randomUUID().slice(0, 8)}`;
      const carrierKey = `${sellerOrder.sellerTenantId}:${idempotencyKey}`;

      // Simulate API process claimed the operation, but crashed BEFORE invoking carrier HTTP call
      // The row exists in PostgreSQL as IN_PROGRESS with an updated_at from 45 seconds ago (stale lease)
      await db.query(
        `INSERT INTO carrier_shipment_operations (
          idempotency_key, seller_order_id, seller_tenant_id, carrier, status, claim_token, created_at, updated_at
        ) VALUES ($1, $2, $3, 'USPS', 'IN_PROGRESS', $4, CURRENT_TIMESTAMP - INTERVAL '45 seconds', CURRENT_TIMESTAMP - INTERVAL '45 seconds')`,
        [
          carrierKey,
          sellerOrder.id,
          sellerOrder.sellerTenantId,
          `crashed_token_${randomUUID().slice(0, 8)}`,
        ],
      );

      const callsBefore = shippoApiCallCount;

      // Retry request arrives at backend API
      const retryRes = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          sellerOrderId: sellerOrder.id,
          items: [{ orderItemId: orderItem.id, quantity: 1 }],
          carrier: 'USPS',
          idempotencyKey,
        },
      });

      expect(retryRes.statusCode).toBe(201);
      const shipment = retryRes.json();
      expect(shipment.carrierShipmentId).toBeDefined();
      expect(shipment.trackingNumber).toBeDefined();

      // Proves: Stale operation was reclaimed and carrier was called exactly once on retry
      expect(shippoApiCallCount - callsBefore).toBe(2);

      // Verify PostgreSQL carrier operation transitioned to COMPLETED
      const opRow = await db.query<{ status: string; carrier_shipment_id: string }>(
        `SELECT status, carrier_shipment_id FROM carrier_shipment_operations WHERE idempotency_key = $1`,
        [carrierKey],
      );
      expect(opRow.rows[0]?.status).toBe('COMPLETED');
      expect(opRow.rows[0]?.carrier_shipment_id).toBe(shipment.carrierShipmentId);
    });

    it('proves active lease is protected while expired lease is safely reclaimable', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder } = await createPaidOrder(eco, 1);
      const repo = new FulfillmentRepository(db);
      const idempotencyKey = `idemp_lease_test_${randomUUID().slice(0, 8)}`;

      // Claim a live operation (updated just now)
      const claim1 = await repo.claimCarrierOperation({
        sellerOrderId: sellerOrder.id,
        sellerTenantId: sellerOrder.sellerTenantId,
        carrier: 'USPS',
        idempotencyKey,
        claimToken: 'worker_active',
        leaseTimeoutMs: 30000,
      });
      expect(claim1.claimed).toBe(true);

      // Attempt to claim again while lease is still ACTIVE (within 30s)
      const claimActiveAttempt = await repo.claimCarrierOperation({
        sellerOrderId: sellerOrder.id,
        sellerTenantId: sellerOrder.sellerTenantId,
        carrier: 'USPS',
        idempotencyKey,
        claimToken: 'worker_stealer',
        leaseTimeoutMs: 30000,
      });
      // MUST NOT be stolen while another instance may still be calling the carrier
      expect(claimActiveAttempt.claimed).toBe(false);
      expect(claimActiveAttempt.operation.claim_token).toBe('worker_active');

      // Now backdate updated_at by 40s to simulate lease expiration
      await db.query(
        `UPDATE carrier_shipment_operations
         SET updated_at = CURRENT_TIMESTAMP - INTERVAL '40 seconds'
         WHERE idempotency_key = $1`,
        [idempotencyKey],
      );

      // Attempt to reclaim the expired lease
      const claimStaleAttempt = await repo.claimCarrierOperation({
        sellerOrderId: sellerOrder.id,
        sellerTenantId: sellerOrder.sellerTenantId,
        carrier: 'USPS',
        idempotencyKey,
        claimToken: 'worker_reclaimer',
        leaseTimeoutMs: 30000,
      });
      // MUST be successfully reclaimed with new claim_token
      expect(claimStaleAttempt.claimed).toBe(true);
      expect(claimStaleAttempt.operation.claim_token).toBe('worker_reclaimer');
    });

    it('guarantees exactly one winner when two instances simultaneously attempt stale-operation recovery', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder } = await createPaidOrder(eco, 1);
      const repo = new FulfillmentRepository(db);
      const idempotencyKey = `idemp_race_reclaim_${randomUUID().slice(0, 8)}`;

      // Seed a stale operation in PostgreSQL
      await db.query(
        `INSERT INTO carrier_shipment_operations (
          idempotency_key, seller_order_id, seller_tenant_id, carrier, status, claim_token, created_at, updated_at
        ) VALUES ($1, $2, $3, 'USPS', 'IN_PROGRESS', 'old_crashed_worker', CURRENT_TIMESTAMP - INTERVAL '50 seconds', CURRENT_TIMESTAMP - INTERVAL '50 seconds')`,
        [idempotencyKey, sellerOrder.id, sellerOrder.sellerTenantId],
      );

      // Two API instances concurrently attempt to reclaim the stale lease
      const [attempt1, attempt2] = await Promise.all([
        repo.claimCarrierOperation({
          sellerOrderId: sellerOrder.id,
          sellerTenantId: sellerOrder.sellerTenantId,
          carrier: 'USPS',
          idempotencyKey,
          claimToken: 'worker_node_A',
          leaseTimeoutMs: 30000,
        }),
        repo.claimCarrierOperation({
          sellerOrderId: sellerOrder.id,
          sellerTenantId: sellerOrder.sellerTenantId,
          carrier: 'USPS',
          idempotencyKey,
          claimToken: 'worker_node_B',
          leaseTimeoutMs: 30000,
        }),
      ]);

      // Exactly ONE instance must win the claim; two instances must NEVER simultaneously believe they own it
      const winnerCount = (attempt1.claimed ? 1 : 0) + (attempt2.claimed ? 1 : 0);
      expect(winnerCount).toBe(1);

      // Verify winner holds the token in PostgreSQL
      const row = await repo.findCarrierOperation(idempotencyKey);
      expect(row?.status).toBe('IN_PROGRESS');
      expect(['worker_node_A', 'worker_node_B']).toContain(row?.claim_token);
    });

    it('recovers when carrier creates shipment but process crashes before PostgreSQL stores carrier_shipment_id via carrier-side idempotency', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);
      const idempotencyKey = `idemp_carrier_pre_db_crash_${randomUUID().slice(0, 8)}`;
      const carrierKey = `${sellerOrder.sellerTenantId}:${idempotencyKey}`;

      // 1. Initial attempt: Carrier HTTP call succeeds at provider
      // Shippo generates label and returns HTTP 201 with Idempotency-Key
      const firstCallResult = await realShippoProvider.createShipment({
        sellerOrderId: sellerOrder.id,
        customerOrderId: sellerOrder.customerOrderId,
        senderAddress: {
          name: 'Alpha',
          street1: '100 Mission St',
          city: 'SF',
          state: 'CA',
          postalCode: '94105',
          country: 'US',
        },
        recipientAddress: {
          name: 'Customer',
          street1: '500 Market St',
          city: 'SF',
          state: 'CA',
          postalCode: '94105',
          country: 'US',
        },
        items: [{ orderItemId: orderItem.id, quantity: 1 }],
        carrier: 'USPS',
        idempotencyKey: carrierKey,
      });

      expect(firstCallResult.carrierShipmentId).toBeDefined();
      expect(firstCallResult.trackingNumber).toBeDefined();

      // SIMULATE CRASH: Process dies right after carrier HTTP response returns,
      // BEFORE completeCarrierOperation can write carrier_shipment_id to PostgreSQL.
      // Insert stale IN_PROGRESS row to represent the crashed process state.
      await db.query(
        `INSERT INTO carrier_shipment_operations (
          idempotency_key, seller_order_id, seller_tenant_id, carrier, status, claim_token, created_at, updated_at
        ) VALUES ($1, $2, $3, 'USPS', 'IN_PROGRESS', 'crashed_token', CURRENT_TIMESTAMP - INTERVAL '40 seconds', CURRENT_TIMESTAMP - INTERVAL '40 seconds')`,
        [carrierKey, sellerOrder.id, sellerOrder.sellerTenantId],
      );

      // Clear in-memory ledger to prove no in-memory cache is relied upon
      realShippoProvider.clearIdempotencyLedger();

      // 2. Retry request arrives (e.g. from client retry or another API instance)
      const retryRes = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          sellerOrderId: sellerOrder.id,
          items: [{ orderItemId: orderItem.id, quantity: 1 }],
          carrier: 'USPS',
          idempotencyKey,
        },
      });

      expect(retryRes.statusCode).toBe(201);
      const retryShipment = retryRes.json();

      // Proves: Reclaimed stale operation and Shippo returned the existing transaction
      // matching the first call's carrier shipment ID and tracking number without duplicate postage!
      expect(retryShipment.carrierShipmentId).toBe(firstCallResult.carrierShipmentId);
      expect(retryShipment.trackingNumber).toBe(firstCallResult.trackingNumber);

      // PostgreSQL carrier_shipment_operations is now marked COMPLETED
      const finalOp = await db.query<{ status: string; carrier_shipment_id: string }>(
        `SELECT status, carrier_shipment_id FROM carrier_shipment_operations WHERE idempotency_key = $1`,
        [carrierKey],
      );
      expect(finalOp.rows[0]?.status).toBe('COMPLETED');
      expect(finalOp.rows[0]?.carrier_shipment_id).toBe(firstCallResult.carrierShipmentId);
    });

    it('preserves carrier_shipment_operations and avoids dangling records when business transaction rolls back', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);
      const idempotencyKey = `idemp_rollback_test_${randomUUID().slice(0, 8)}`;
      const carrierKey = `${sellerOrder.sellerTenantId}:${idempotencyKey}`;

      // Durably complete carrier operation in PostgreSQL
      await db.query(
        `INSERT INTO carrier_shipment_operations (
          idempotency_key, seller_order_id, seller_tenant_id, carrier, carrier_shipment_id,
          tracking_number, tracking_url, label_url, status, created_at, updated_at
        ) VALUES ($1, $2, $3, 'USPS', 'shp_rollback_123', 'TRK_ROLLBACK_123', 'https://track.com', 'https://label.com', 'COMPLETED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [carrierKey, sellerOrder.id, sellerOrder.sellerTenantId],
      );

      // Verify no shipment exists initially
      const initialShipments = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM shipments WHERE seller_order_id = $1`,
        [sellerOrder.id],
      );
      expect(Number(initialShipments.rows[0]!.count)).toBe(0);

      // Clear in-memory caches
      realShippoProvider.clearIdempotencyLedger();

      // Successful retry reconciles from PostgreSQL carrier_shipment_operations
      const res = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          sellerOrderId: sellerOrder.id,
          items: [{ orderItemId: orderItem.id, quantity: 1 }],
          carrier: 'USPS',
          idempotencyKey,
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().carrierShipmentId).toBe('shp_rollback_123');
      expect(res.json().trackingNumber).toBe('TRK_ROLLBACK_123');

      // Exactly ONE internal shipment created
      const finalShipments = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM shipments WHERE seller_order_id = $1`,
        [sellerOrder.id],
      );
      expect(Number(finalShipments.rows[0]!.count)).toBe(1);
    });
  });

  // --- 13. ATOMIC SHIPMENT + OUTBOX TRANSACTION ---
  describe('13. Atomic Shipment + Outbox Transaction', () => {
    it('records FULFILLMENT_SHIPMENT_CREATED outbox event in the same atomic PostgreSQL transaction', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      const res = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          sellerOrderId: sellerOrder.id,
          items: [{ orderItemId: orderItem.id, quantity: 1 }],
          carrier: 'USPS',
        },
      });
      expect(res.statusCode).toBe(201);
      const shipment = res.json();

      // Inspect outbox_events table in PostgreSQL using event_id primary key
      const outboxRows = await db.query<{
        event_id: string;
        event_type: string;
        aggregate_id: string;
        payload: string | Record<string, unknown>;
      }>(
        `SELECT event_id, event_type, aggregate_id, payload FROM outbox_events WHERE aggregate_id = $1`,
        [shipment.id],
      );

      expect(outboxRows.rows.length).toBeGreaterThanOrEqual(1);
      const createdEvent = outboxRows.rows.find(
        (r) => r.event_type === EventTypes.FULFILLMENT_SHIPMENT_CREATED,
      );
      expect(createdEvent).toBeDefined();
      const payload =
        typeof createdEvent!.payload === 'string'
          ? JSON.parse(createdEvent!.payload)
          : createdEvent!.payload;
      expect(payload.shipmentId).toBe(shipment.id);
      expect(payload.carrierShipmentId).toBe(shipment.carrierShipmentId);
      expect(payload.trackingNumber).toBe(shipment.trackingNumber);
    });
  });

  // --- 14. ATOMIC WEBHOOK STATE + OUTBOX TRANSACTION ---
  describe('14. Atomic Webhook State + Outbox Transaction', () => {
    it('records FULFILLMENT_SHIPMENT_STATUS_CHANGED in the same atomic transaction upon carrier webhook', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      const shipRes = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: {
            sellerOrderId: sellerOrder.id,
            items: [{ orderItemId: orderItem.id, quantity: 1 }],
          },
        })
      ).json();

      await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${shipRes.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'SHIPPED' },
      });

      const webhookPayload = JSON.stringify({
        event: 'track_updated',
        event_id: `evt_tx_test_${randomUUID().slice(0, 8)}`,
        data: {
          carrier: shipRes.carrier,
          tracking_number: shipRes.trackingNumber,
          tracking_status: { status: 'TRANSIT', status_date: new Date().toISOString() },
        },
      });
      const sig = createShippoWebhookSignature(webhookPayload);

      await app.inject({
        method: 'POST',
        url: '/fulfillment/carrier/callback',
        headers: { 'Content-Type': 'application/json', 'shippo-signature': sig },
        payload: webhookPayload,
      });

      const outboxRows = await db.query<{
        event_id: string;
        event_type: string;
        aggregate_id: string;
        payload: string | Record<string, unknown>;
      }>(
        `SELECT event_id, event_type, aggregate_id, payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = $2`,
        [shipRes.id, EventTypes.FULFILLMENT_SHIPMENT_STATUS_CHANGED],
      );

      expect(outboxRows.rows.length).toBeGreaterThanOrEqual(1);
      const statusEvt = outboxRows.rows.find((r) => {
        const p = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
        return p.newStatus === 'IN_TRANSIT';
      });
      expect(statusEvt).toBeDefined();
      const payload =
        typeof statusEvt!.payload === 'string'
          ? JSON.parse(statusEvt!.payload)
          : statusEvt!.payload;
      expect(payload.newStatus).toBe('IN_TRANSIT');
      expect(payload.previousStatus).toBe('SHIPPED');
    });
  });

  // --- 15. SHIPMENT CANCELLATION ---
  describe('15. Shipment Cancellation via Carrier', () => {
    it('cancels shipment with carrier refund and updates status to CANCELLED', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      const shipRes = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: {
            sellerOrderId: sellerOrder.id,
            items: [{ orderItemId: orderItem.id, quantity: 1 }],
          },
        })
      ).json();

      const cancelRes = await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${shipRes.id}/cancel`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { reason: 'Customer requested address change' },
      });

      expect(cancelRes.statusCode).toBe(200);
      expect(cancelRes.json().status).toBe('CANCELLED');

      // Verify cancellation outbox event
      const outboxRows = await db.query<{ event_type: string }>(
        `SELECT event_type FROM outbox_events WHERE aggregate_id = $1 AND event_type = $2`,
        [shipRes.id, EventTypes.FULFILLMENT_SHIPMENT_STATUS_CHANGED],
      );
      expect(outboxRows.rows.length).toBeGreaterThanOrEqual(1);
    });
  });

  // --- 16. RETURN SHIPMENT CREATION ---
  describe('16. Return Shipment Creation', () => {
    it('creates return label with carrier adapter when return is approved', async () => {
      const eco = await setupEcosystem();
      const { order, sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      // Fulfill and Deliver
      const ship = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: {
            sellerOrderId: sellerOrder.id,
            items: [{ orderItemId: orderItem.id, quantity: 1 }],
          },
        })
      ).json();

      await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${ship.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'SHIPPED' },
      });
      await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${ship.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'IN_TRANSIT' },
      });
      await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${ship.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'OUT_FOR_DELIVERY' },
      });
      await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${ship.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'DELIVERED' },
      });

      // Customer creates return request
      const returnRes = await app.inject({
        method: 'POST',
        url: '/fulfillment/returns',
        headers: { authorization: `Bearer ${eco.custToken}` },
        payload: {
          customerOrderId: order.id,
          sellerOrderId: sellerOrder.id,
          reason: 'Defective power port',
          items: [{ orderItemId: orderItem.id, quantity: 1 }],
        },
      });
      expect(returnRes.statusCode).toBe(201);
      const ret = returnRes.json();

      // Merchant approves return
      const approveRes = await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'APPROVED' },
      });
      expect(approveRes.statusCode).toBe(200);
      const approvedRet = approveRes.json();
      expect(approvedRet.status).toBe('APPROVED');
      expect(approvedRet.metadata?.['returnLabelUrl']).toBeDefined();
      expect(approvedRet.metadata?.['returnTrackingNumber']).toBeDefined();
    });
  });

  // --- 17, 18, 19. RBAC & TENANT ISOLATION ---
  describe('17, 18, 19. RBAC & Tenant Isolation', () => {
    it('prevents customer from fulfilling shipments', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      const res = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.custToken}` },
        payload: {
          sellerOrderId: sellerOrder.id,
          items: [{ orderItemId: orderItem.id, quantity: 1 }],
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('prevents Merchant Beta from fulfilling Merchant Alpha seller order', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      const res = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.betaToken}` },
        payload: {
          sellerOrderId: sellerOrder.id,
          items: [{ orderItemId: orderItem.id, quantity: 1 }],
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows customer to view shipments for their own orders but blocks other tenant shipments', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      const ship = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: {
            sellerOrderId: sellerOrder.id,
            items: [{ orderItemId: orderItem.id, quantity: 1 }],
          },
        })
      ).json();

      // Customer reads own shipment
      const custView = await app.inject({
        method: 'GET',
        url: `/fulfillment/shipments/${ship.id}`,
        headers: { authorization: `Bearer ${eco.custToken}` },
      });
      expect(custView.statusCode).toBe(200);

      // Other customer registers and attempts to access
      const otherCustToken = await registerVerifiedUser(app, db, {
        email: 'other@buyer.com',
        password: 'Password123!',
        tenantName: 'Other Customer Tenant',
        role: 'CUSTOMER',
      });
      const blockedView = await app.inject({
        method: 'GET',
        url: `/fulfillment/shipments/${ship.id}`,
        headers: { authorization: `Bearer ${otherCustToken}` },
      });
      // 404 is returned to protect tenant privacy and prevent ID enumeration
      expect(blockedView.statusCode).toBe(404);
    });
  });

  // --- 20. APPLICATION RESTART / RECOVERY ---
  describe('20. Application Restart & Persistence Recovery', () => {
    it('reads and manages existing shipments after a cold application restart', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      const ship = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: {
            sellerOrderId: sellerOrder.id,
            items: [{ orderItemId: orderItem.id, quantity: 1 }],
          },
        })
      ).json();

      // Close current app
      await app.close();

      // Instantiate fresh app with same database and full configuration
      const config = getTestConfig();
      const newProvider = new ShippoCarrierProvider(
        { apiKey: shippoApiKey, fetchFn: mockShippoFetch },
        logger,
      );

      const restartedApp = await buildApp({
        config,
        logger,
        carrierProvider: newProvider,
        dbConnection: db,
        skipMigrations: true,
      });
      await restartedApp.ready();

      // Query shipment on new app instance
      const res = await restartedApp.inject({
        method: 'GET',
        url: `/fulfillment/shipments/${ship.id}`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(ship.id);
      expect(res.json().carrierShipmentId).toBe(ship.carrierShipmentId);
      expect(res.json().labelUrl).toBe(ship.labelUrl);

      await restartedApp.close();
    });
  });

  // --- 21. MERCHANT FRONTEND CONTRACT ---
  describe('21. Merchant Frontend Fulfillment Contract', () => {
    it('provides endpoints required by MerchantFulfillment.tsx and MerchantOrders.tsx', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      // 1. Merchant retrieves seller orders
      const ordersRes = await app.inject({
        method: 'GET',
        url: '/seller/orders',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      });
      expect(ordersRes.statusCode).toBe(200);
      expect(Array.isArray(ordersRes.json())).toBe(true);
      expect(ordersRes.json().length).toBeGreaterThanOrEqual(1);

      // 2. Merchant creates shipment
      const shipRes = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          sellerOrderId: sellerOrder.id,
          carrier: 'USPS',
          items: [{ orderItemId: orderItem.id, quantity: 1 }],
        },
      });
      expect(shipRes.statusCode).toBe(201);
      const ship = shipRes.json();
      expect(ship.carrierShipmentId).toBeDefined();
      expect(ship.labelUrl).toBeDefined();

      // 3. Merchant fetches live tracking telemetry
      const trackingRes = await app.inject({
        method: 'GET',
        url: `/fulfillment/shipments/${ship.id}/tracking`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      });
      expect(trackingRes.statusCode).toBe(200);
      expect(trackingRes.json().trackingNumber).toBe(ship.trackingNumber);
    });
  });

  // --- 22. CUSTOMER FRONTEND CONTRACT ---
  describe('22. Customer Frontend Tracking Contract', () => {
    it('provides tracking data consumed by CustomerOrders.tsx and ShipmentTracker.tsx', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      const ship = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: {
            sellerOrderId: sellerOrder.id,
            items: [{ orderItemId: orderItem.id, quantity: 1 }],
          },
        })
      ).json();

      // Customer fetches their orders
      const custOrders = await app.inject({
        method: 'GET',
        url: '/orders',
        headers: { authorization: `Bearer ${eco.custToken}` },
      });
      expect(custOrders.statusCode).toBe(200);

      // Customer opens shipment tracker
      const shipTracker = await app.inject({
        method: 'GET',
        url: `/fulfillment/shipments/${ship.id}`,
        headers: { authorization: `Bearer ${eco.custToken}` },
      });
      expect(shipTracker.statusCode).toBe(200);
      const trackerData = shipTracker.json();
      expect(trackerData.trackingNumber).toBe(ship.trackingNumber);
      expect(trackerData.carrier).toBe(ship.carrier);
      expect(trackerData.status).toBe('READY_TO_SHIP');
    });
  });

  // --- 23. EXISTING ORDER & PAYMENT REGRESSION ---
  describe('23. Existing Order and Payment Flow Regression', () => {
    it('preserves full checkout -> payment -> order -> seller orders creation flow', async () => {
      const eco = await setupEcosystem();
      const { order, sellerOrder, orderItem } = await createPaidOrder(eco, 2);

      expect(order.status).toBe('PAID');
      expect(sellerOrder.status).toBe('PAID');
      expect(sellerOrder.sellerTenantId).toBe(eco.profA.tenantId);
      expect(orderItem.quantity).toBe(2);
    });
  });

  // --- 24. EXISTING RETURNS REGRESSION ---
  describe('24. Existing Returns Regression', () => {
    it('preserves full return request -> restock inventory -> refund completion flow', async () => {
      const eco = await setupEcosystem();
      const { order, sellerOrder, orderItem } = await createPaidOrder(eco, 2);

      // Deliver shipment
      const ship = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: {
            sellerOrderId: sellerOrder.id,
            items: [{ orderItemId: orderItem.id, quantity: 2 }],
          },
        })
      ).json();

      await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${ship.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'SHIPPED' },
      });
      await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${ship.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'IN_TRANSIT' },
      });
      await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${ship.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'OUT_FOR_DELIVERY' },
      });
      await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${ship.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'DELIVERED' },
      });

      // Request Return
      const ret = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/returns',
          headers: { authorization: `Bearer ${eco.custToken}` },
          payload: {
            customerOrderId: order.id,
            sellerOrderId: sellerOrder.id,
            reason: 'Item defective',
            items: [{ orderItemId: orderItem.id, quantity: 1 }],
          },
        })
      ).json();

      // Approve -> In Transit -> Receive -> Complete with Restock
      await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'APPROVED' },
      });
      await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'IN_TRANSIT' },
      });
      await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'RECEIVED' },
      });
      const compRes = await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'COMPLETED', restock: true, restockCondition: 'SELLABLE' },
      });
      expect(compRes.statusCode).toBe(200);
      const completedRet = compRes.json();

      expect(completedRet.status).toBe('COMPLETED');
      expect(completedRet.refundId).toBeDefined();

      // Verify seller order completion evaluation
      const soRes = await app.inject({
        method: 'GET',
        url: `/seller/orders/${sellerOrder.id}`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      });
      expect(soRes.json().status).toBe('COMPLETED');
    });
  });
});
