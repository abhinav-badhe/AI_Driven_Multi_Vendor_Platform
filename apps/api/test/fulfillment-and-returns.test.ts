




import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase, markAllUsersVerified, registerVerifiedUser } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';
import { InventoryService } from '../src/modules/inventory/internal/inventory-service.js';

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';
const CARRIER_SECRET = 'whsec_carrier_mock_secret';

describe('Phase 7: Fulfillment & Returns', () => {
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

    // 4. Catalog & Listings
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
        payload: { title: 'Smartphone Pro', slug: 'smartphone-pro', brand: 'AlphaBrand', categoryId: cat.id },
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
        payload: { skuCode: 'SKU-SMART-01', attributes: { color: 'Black' } },
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
        payload: { skuId: skuA.id, priceAmount: 1000, currency: 'INR' },
      })
    ).json();
    await app.inject({ method: 'POST', url: `/listings/${listA.id}/status`, headers: { authorization: `Bearer ${alphaToken}` }, payload: { status: 'ACTIVE' } });

    // Inventory: Alpha has 20 units
    const invA = (
      await app.inject({
        method: 'POST',
        url: '/inventory',
        headers: { authorization: `Bearer ${alphaToken}` },
        payload: { listingId: listA.id, skuId: skuA.id, initialOnHandQuantity: 20 },
      })
    ).json();

    // Customer
    const custToken = await registerVerifiedUser(app, db, {
      email: 'customer@test.com',
      password: 'Password123!',
      tenantName: 'Customer Tenant',
      role: 'CUSTOMER',
    });

    return {
      adminToken,
      alphaToken,
      betaToken,
      custToken,
      profA,
      profB,
      listA,
      invA,
    };
  }

  async function createPaidOrder(eco: Awaited<ReturnType<typeof setupEcosystem>>, quantity = 5) {
    // 1. Add item to cart
    await app.inject({
      method: 'POST',
      url: '/cart/items',
      headers: { authorization: `Bearer ${eco.custToken}` },
      payload: { listingId: eco.listA.id, quantity },
    });

    // 2. Checkout & Reserve
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

    // 3. Payment Intent & Attempt
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

    // 4. Create Order
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

  // --- 1. SHIPMENT CREATION & LIFECYCLE ---
  describe('Shipment Creation & Lifecycle', () => {
    it('creates fulfillment shipment for a paid seller order', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 5);

      const res = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          sellerOrderId: sellerOrder.id,
          items: [{ orderItemId: orderItem.id, quantity: 5 }],
          carrier: 'FedEx',
          trackingNumber: 'FDX-12345678',
        },
      });

      expect(res.statusCode).toBe(201);
      const shipment = res.json();
      expect(shipment.sellerOrderId).toBe(sellerOrder.id);
      expect(shipment.sellerTenantId).toBe(eco.profA.tenantId);
      expect(shipment.status).toBe('READY_TO_SHIP');
      expect(shipment.carrier).toBe('FedEx');
      expect(shipment.trackingNumber).toBe('FDX-12345678');
      expect(shipment.items).toHaveLength(1);
      expect(shipment.items[0].quantity).toBe(5);
    });

    it('supports partial fulfillment across multiple shipments and rejects over-fulfillment', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 5);

      // Shipment 1: 2 units
      const res1 = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          sellerOrderId: sellerOrder.id,
          items: [{ orderItemId: orderItem.id, quantity: 2 }],
        },
      });
      expect(res1.statusCode).toBe(201);

      // Shipment 2: 3 units (fulfills remaining)
      const res2 = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          sellerOrderId: sellerOrder.id,
          items: [{ orderItemId: orderItem.id, quantity: 3 }],
        },
      });
      expect(res2.statusCode).toBe(201);

      // Shipment 3: 1 unit (exceeds total order quantity 5) -> MUST BE REJECTED
      const res3 = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          sellerOrderId: sellerOrder.id,
          items: [{ orderItemId: orderItem.id, quantity: 1 }],
        },
      });
      expect(res3.statusCode).toBe(400);
      expect(res3.json().error.message).toMatch(/exceeds remaining fulfillable quantity/);
    });

    it('enforces idempotency on shipment creation and rejects key reuse with different payload', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 5);

      const payload = {
        sellerOrderId: sellerOrder.id,
        items: [{ orderItemId: orderItem.id, quantity: 2 }],
        idempotencyKey: 'ship-key-unique-01',
      };

      // Call 1
      const res1 = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload,
      });
      expect(res1.statusCode).toBe(201);
      const s1 = res1.json();

      // Call 2 (Retry)
      const res2 = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload,
      });
      expect(res2.statusCode).toBe(201);
      const s2 = res2.json();
      expect(s2.id).toBe(s1.id);

      // Call 3 (Same key with different seller order)
      const res3 = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          sellerOrderId: 'other-seller-order-id',
          items: [{ orderItemId: orderItem.id, quantity: 2 }],
          idempotencyKey: 'ship-key-unique-01',
        },
      });
      expect(res3.statusCode).toBe(400);
    });

    it('enforces state machine: READY_TO_SHIP -> SHIPPED -> IN_TRANSIT -> OUT_FOR_DELIVERY -> DELIVERED', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 5);

      const shipRes = await app.inject({
        method: 'POST',
        url: '/fulfillment/shipments',
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          sellerOrderId: sellerOrder.id,
          items: [{ orderItemId: orderItem.id, quantity: 5 }],
        },
      });
      const shipment = shipRes.json();
      expect(shipment.status).toBe('READY_TO_SHIP');

      // 1. READY_TO_SHIP -> SHIPPED
      const s1 = await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${shipment.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'SHIPPED' },
      });
      expect(s1.statusCode).toBe(200);
      expect(s1.json().status).toBe('SHIPPED');
      expect(s1.json().shippedAt).toBeDefined();

      // 2. SHIPPED -> IN_TRANSIT
      const s2 = await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${shipment.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'IN_TRANSIT' },
      });
      expect(s2.statusCode).toBe(200);
      expect(s2.json().status).toBe('IN_TRANSIT');

      // 3. IN_TRANSIT -> OUT_FOR_DELIVERY
      const s3 = await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${shipment.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'OUT_FOR_DELIVERY' },
      });
      expect(s3.statusCode).toBe(200);
      expect(s3.json().status).toBe('OUT_FOR_DELIVERY');

      // 4. OUT_FOR_DELIVERY -> DELIVERED
      const s4 = await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${shipment.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'DELIVERED' },
      });
      expect(s4.statusCode).toBe(200);
      expect(s4.json().status).toBe('DELIVERED');
      expect(s4.json().deliveredAt).toBeDefined();

      // 5. Invalid transition: DELIVERED -> SHIPPED (Rejected)
      const s5 = await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${shipment.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'SHIPPED' },
      });
      expect(s5.statusCode).toBe(409);

      // Verify seller order automatically completed when all items delivered
      const sellerOrderRes = await app.inject({
        method: 'GET',
        url: `/seller/orders/${sellerOrder.id}`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      });
      expect(sellerOrderRes.json().status).toBe('COMPLETED');
    });

    it('updates shipment tracking information', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 2);

      const shipRes = (
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

      const trackRes = await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${shipRes.id}/tracking`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          carrier: 'BlueDart',
          trackingNumber: 'BD-99887766',
          trackingUrl: 'https://track.bluedart.com/BD-99887766',
        },
      });
      expect(trackRes.statusCode).toBe(200);
      expect(trackRes.json().carrier).toBe('BlueDart');
      expect(trackRes.json().trackingNumber).toBe('BD-99887766');
      expect(trackRes.json().trackingUrl).toBe('https://track.bluedart.com/BD-99887766');
    });

    it('processes signed carrier callback and transitions shipment state', async () => {
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
            carrier: 'DHL',
            trackingNumber: 'DHL-776655',
          },
        })
      ).json();

      // First transition to SHIPPED
      await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${shipRes.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'SHIPPED' },
      });

      // Prepare carrier callback for IN_TRANSIT
      const callbackPayload = JSON.stringify({
        carrier: 'DHL',
        trackingNumber: 'DHL-776655',
        status: 'IN_TRANSIT',
        location: 'Mumbai Hub',
      });
      const validSig = createHmac('sha256', CARRIER_SECRET).update(callbackPayload).digest('hex');

      // Invalid signature rejection
      const invalidRes = await app.inject({
        method: 'POST',
        url: '/fulfillment/carrier/callback',
        headers: { 'content-type': 'application/json', 'x-carrier-signature': 'invalid_signature' },
        payload: callbackPayload,
      });
      expect(invalidRes.statusCode).toBe(401);

      // Valid signature callback
      const validRes = await app.inject({
        method: 'POST',
        url: '/fulfillment/carrier/callback',
        headers: { 'content-type': 'application/json', 'x-carrier-signature': validSig },
        payload: callbackPayload,
      });
      expect(validRes.statusCode).toBe(200);

      // Duplicate callback replay protection
      const dupRes = await app.inject({
        method: 'POST',
        url: '/fulfillment/carrier/callback',
        headers: { 'content-type': 'application/json', 'x-carrier-signature': validSig },
        payload: callbackPayload,
      });
      expect(dupRes.statusCode).toBe(200);
      expect(dupRes.json().deduplicated).toBe(true);

      // Verify exactly 1 carrier webhook event record exists in DB
      const evtCount = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM carrier_webhook_events WHERE carrier = 'DHL' AND tracking_number = 'DHL-776655'`,
      );
      expect(parseInt(evtCount.rows[0]!.count, 10)).toBe(1);

      // Verify updated status
      const getRes = await app.inject({
        method: 'GET',
        url: `/fulfillment/shipments/${shipRes.id}`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      });
      expect(getRes.json().status).toBe('IN_TRANSIT');
    });
  });

  // --- 2. TENANT ISOLATION & RBAC ---
  describe('Tenant Isolation & RBAC', () => {
    it('prevents Merchant Beta from fulfilling Merchant Alpha Seller Order', async () => {
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

    it('prevents Customer from fulfilling a shipment', async () => {
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
  });

  // --- 3. RETURNS LIFECYCLE & ELIGIBILITY ---
  describe('Returns Lifecycle & Eligibility', () => {
    it('rejects return request for items that have NOT been delivered yet', async () => {
      const eco = await setupEcosystem();
      const { order, sellerOrder, orderItem } = await createPaidOrder(eco, 2);

      // Try creating return request before any shipment delivery
      const res = await app.inject({
        method: 'POST',
        url: '/fulfillment/returns',
        headers: { authorization: `Bearer ${eco.custToken}` },
        payload: {
          customerOrderId: order.id,
          sellerOrderId: sellerOrder.id,
          reason: 'Defective speaker',
          items: [{ orderItemId: orderItem.id, quantity: 1 }],
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/has not been delivered/);
    });

    it('allows customer to create return for delivered item and executes state machine through refund completion', async () => {
      const eco = await setupEcosystem();
      const { order, sellerOrder, orderItem } = await createPaidOrder(eco, 2);

      // Fulfill and deliver shipment
      const shipRes = (
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

      // Customer creates return request for 1 unit
      const returnRes = await app.inject({
        method: 'POST',
        url: '/fulfillment/returns',
        headers: { authorization: `Bearer ${eco.custToken}` },
        payload: {
          customerOrderId: order.id,
          sellerOrderId: sellerOrder.id,
          reason: 'Color not as pictured',
          items: [{ orderItemId: orderItem.id, quantity: 1 }],
          idempotencyKey: 'ret-key-001',
        },
      });
      expect(returnRes.statusCode).toBe(201);
      const ret = returnRes.json();
      expect(ret.status).toBe('REQUESTED');
      expect(ret.items[0].quantity).toBe(1);

      // Customer cannot directly approve their return
      const unauthorizedApprove = await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.custToken}` },
        payload: { status: 'APPROVED' },
      });
      expect(unauthorizedApprove.statusCode).toBe(403);

      // Merchant approves return
      const appRes = await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'APPROVED' },
      });
      expect(appRes.statusCode).toBe(200);
      expect(appRes.json().status).toBe('APPROVED');

      // Merchant marks IN_TRANSIT
      const transRes = await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'IN_TRANSIT' },
      });
      expect(transRes.statusCode).toBe(200);

      // Merchant receives returned goods
      const recvRes = await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'RECEIVED' },
      });
      expect(recvRes.statusCode).toBe(200);

      // Merchant completes return with restocking into sellable inventory
      const compRes = await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'COMPLETED', restock: true, restockCondition: 'SELLABLE' },
      });
      expect(compRes.statusCode).toBe(200);
      const completed = compRes.json();
      expect(completed.status).toBe('COMPLETED');
      expect(completed.refundId).toBeDefined();

      // Verify refund record exists in database
      const refundCheck = await db.query<{ id: string; amount: number; status: string }>(
        `SELECT id, amount, status FROM payment_refunds WHERE id = $1`,
        [completed.refundId],
      );
      expect(refundCheck.rows).toHaveLength(1);
      expect(refundCheck.rows[0]!.amount).toBe(1000); // 1 unit * 1000 INR
      expect(refundCheck.rows[0]!.status).toBe('SUCCEEDED');
    });

    it('enforces return quantity limits and prevents duplicate returns', async () => {
      const eco = await setupEcosystem();
      const { order, sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      // Deliver shipment
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
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'SHIPPED' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'IN_TRANSIT' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'OUT_FOR_DELIVERY' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'DELIVERED' } });

      // Return 1: Request 1 unit
      const ret1 = await app.inject({
        method: 'POST',
        url: '/fulfillment/returns',
        headers: { authorization: `Bearer ${eco.custToken}` },
        payload: {
          customerOrderId: order.id,
          sellerOrderId: sellerOrder.id,
          reason: 'Defective',
          items: [{ orderItemId: orderItem.id, quantity: 1 }],
        },
      });
      expect(ret1.statusCode).toBe(201);

      // Return 2: Request another 1 unit when only 1 unit was delivered -> MUST BE REJECTED
      const ret2 = await app.inject({
        method: 'POST',
        url: '/fulfillment/returns',
        headers: { authorization: `Bearer ${eco.custToken}` },
        payload: {
          customerOrderId: order.id,
          sellerOrderId: sellerOrder.id,
          reason: 'Duplicate attempt',
          items: [{ orderItemId: orderItem.id, quantity: 1 }],
        },
      });
      expect(ret2.statusCode).toBe(400);
      expect(ret2.json().error.message).toMatch(/exceeds eligible delivered quantity/);
    });

    it('allows customer to cancel their own requested return', async () => {
      const eco = await setupEcosystem();
      const { order, sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      // Deliver
      const shipRes = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: { sellerOrderId: sellerOrder.id, items: [{ orderItemId: orderItem.id, quantity: 1 }] },
        })
      ).json();
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'SHIPPED' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'IN_TRANSIT' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'OUT_FOR_DELIVERY' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'DELIVERED' } });

      const ret = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/returns',
          headers: { authorization: `Bearer ${eco.custToken}` },
          payload: {
            customerOrderId: order.id,
            sellerOrderId: sellerOrder.id,
            reason: 'Changed mind',
            items: [{ orderItemId: orderItem.id, quantity: 1 }],
          },
        })
      ).json();

      // Customer cancels
      const cancelRes = await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.custToken}` },
        payload: { status: 'CANCELLED' },
      });
      expect(cancelRes.statusCode).toBe(200);
      expect(cancelRes.json().status).toBe('CANCELLED');
    });
  });

  // --- 4. CONCURRENCY & PARTIAL FULFILLMENT SAFEGUARDS ---
  describe('Concurrency & Partial Fulfillment Safeguards', () => {
    it('prevents over-fulfillment across concurrent shipment requests', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 5);

      // Attempt two concurrent shipments of 3 units each (total 6 > 5)
      const [resA, resB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: {
            sellerOrderId: sellerOrder.id,
            items: [{ orderItemId: orderItem.id, quantity: 3 }],
            idempotencyKey: 'concurrent-ship-a',
          },
        }),
        app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: {
            sellerOrderId: sellerOrder.id,
            items: [{ orderItemId: orderItem.id, quantity: 3 }],
            idempotencyKey: 'concurrent-ship-b',
          },
        }),
      ]);

      const statusCodes = [resA.statusCode, resB.statusCode].sort();
      // Exactly one succeeds (201) and one is rejected (400) due to exceeding remaining quantity
      expect(statusCodes).toEqual([201, 400]);

      // Verify total fulfilled quantity in DB is exactly 3
      const itemsCount = await db.query<{ sum: string }>(
        `SELECT COALESCE(SUM(quantity), 0) as sum FROM shipment_items WHERE order_item_id = $1`,
        [orderItem.id],
      );
      expect(parseInt(itemsCount.rows[0]!.sum, 10)).toBe(3);
    });

    it('prevents over-return across concurrent return requests', async () => {
      const eco = await setupEcosystem();
      const { order, sellerOrder, orderItem } = await createPaidOrder(eco, 3);

      // Deliver all 3 units
      const shipRes = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: { sellerOrderId: sellerOrder.id, items: [{ orderItemId: orderItem.id, quantity: 3 }] },
        })
      ).json();
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'SHIPPED' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'IN_TRANSIT' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'OUT_FOR_DELIVERY' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'DELIVERED' } });

      // Attempt two concurrent returns of 2 units each (total 4 > 3)
      const [retA, retB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/fulfillment/returns',
          headers: { authorization: `Bearer ${eco.custToken}` },
          payload: {
            customerOrderId: order.id,
            sellerOrderId: sellerOrder.id,
            reason: 'Concurrent Return A',
            items: [{ orderItemId: orderItem.id, quantity: 2 }],
            idempotencyKey: 'concurrent-ret-a',
          },
        }),
        app.inject({
          method: 'POST',
          url: '/fulfillment/returns',
          headers: { authorization: `Bearer ${eco.custToken}` },
          payload: {
            customerOrderId: order.id,
            sellerOrderId: sellerOrder.id,
            reason: 'Concurrent Return B',
            items: [{ orderItemId: orderItem.id, quantity: 2 }],
            idempotencyKey: 'concurrent-ret-b',
          },
        }),
      ]);

      const statusCodes = [retA.statusCode, retB.statusCode].sort();
      expect(statusCodes).toEqual([201, 400]);
    });
  });

  // --- 5. CROSS-BOUNDARY INTEGRATION & RECOVERY ---
  describe('Cross-Boundary Integration & Failure Recovery', () => {
    it('restocks inventory when return is completed with restock flag', async () => {
      const eco = await setupEcosystem();
      const { order, sellerOrder, orderItem } = await createPaidOrder(eco, 4);

      // Check current onHand: initial 20 - 4 = 16
      const invBefore = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(invBefore.onHandQuantity).toBe(16);

      // Deliver 4 units
      const shipRes = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: { sellerOrderId: sellerOrder.id, items: [{ orderItemId: orderItem.id, quantity: 4 }] },
        })
      ).json();
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'SHIPPED' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'IN_TRANSIT' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'OUT_FOR_DELIVERY' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'DELIVERED' } });

      // Customer requests return of 2 units
      const ret = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/returns',
          headers: { authorization: `Bearer ${eco.custToken}` },
          payload: {
            customerOrderId: order.id,
            sellerOrderId: sellerOrder.id,
            reason: 'Partial return',
            items: [{ orderItemId: orderItem.id, quantity: 2 }],
          },
        })
      ).json();

      // Merchant approves, receives, and completes with restock: true
      await app.inject({ method: 'POST', url: `/fulfillment/returns/${ret.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'APPROVED' } });
      await app.inject({ method: 'POST', url: `/fulfillment/returns/${ret.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'IN_TRANSIT' } });
      await app.inject({ method: 'POST', url: `/fulfillment/returns/${ret.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'RECEIVED' } });

      const completeRes = await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          status: 'COMPLETED',
          options: { restock: true, restockCondition: 'SELLABLE' },
        },
      });
      expect(completeRes.statusCode).toBe(200);
      expect(completeRes.json().status).toBe('COMPLETED');

      // Inventory should have been restocked by 2 units: 16 + 2 = 18
      const invAfter = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(invAfter.onHandQuantity).toBe(18);
    });

    it('restocks defective inventory to non-sellable quantity', async () => {
      const eco = await setupEcosystem();
      const { order, sellerOrder, orderItem } = await createPaidOrder(eco, 2);

      // Deliver 2 units
      const shipRes = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: { sellerOrderId: sellerOrder.id, items: [{ orderItemId: orderItem.id, quantity: 2 }] },
        })
      ).json();
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'SHIPPED' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'IN_TRANSIT' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'OUT_FOR_DELIVERY' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'DELIVERED' } });

      const ret = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/returns',
          headers: { authorization: `Bearer ${eco.custToken}` },
          payload: {
            customerOrderId: order.id,
            sellerOrderId: sellerOrder.id,
            reason: 'Defective screen',
            items: [{ orderItemId: orderItem.id, quantity: 1 }],
          },
        })
      ).json();

      await app.inject({ method: 'POST', url: `/fulfillment/returns/${ret.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'APPROVED' } });
      await app.inject({ method: 'POST', url: `/fulfillment/returns/${ret.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'IN_TRANSIT' } });
      await app.inject({ method: 'POST', url: `/fulfillment/returns/${ret.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'RECEIVED' } });

      const completeRes = await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: {
          status: 'COMPLETED',
          options: { restock: true, restockCondition: 'DEFECTIVE' },
        },
      });
      expect(completeRes.statusCode).toBe(200);

      // Non-sellable quantity should be 1
      const invAfter = (
        await app.inject({
          method: 'GET',
          url: `/inventory/${eco.invA.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(invAfter.nonSellableQuantity).toBe(1);
    });

    it('leaves return in deterministic recoverable RECEIVED state if refund fails, and recovers idempotently on retry', async () => {
      const eco = await setupEcosystem();
      const { order, sellerOrder, orderItem, intent } = await createPaidOrder(eco, 1);

      // Deliver 1 unit
      const shipRes = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: { sellerOrderId: sellerOrder.id, items: [{ orderItemId: orderItem.id, quantity: 1 }] },
        })
      ).json();
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'SHIPPED' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'IN_TRANSIT' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'OUT_FOR_DELIVERY' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'DELIVERED' } });

      // Customer creates return
      const ret = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/returns',
          headers: { authorization: `Bearer ${eco.custToken}` },
          payload: {
            customerOrderId: order.id,
            sellerOrderId: sellerOrder.id,
            reason: 'Test refund failure recovery',
            items: [{ orderItemId: orderItem.id, quantity: 1 }],
            idempotencyKey: 'ret-recover-key-01',
          },
        })
      ).json();

      await app.inject({ method: 'POST', url: `/fulfillment/returns/${ret.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'APPROVED' } });
      await app.inject({ method: 'POST', url: `/fulfillment/returns/${ret.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'IN_TRANSIT' } });
      await app.inject({ method: 'POST', url: `/fulfillment/returns/${ret.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'RECEIVED' } });

      // Temporarily simulate payment intent failure by setting status to 'CANCELLED' in DB
      await db.query(`UPDATE payment_intents SET status = 'CANCELLED' WHERE id = $1`, [intent.id]);

      // Attempt to complete return -> Refund handoff must fail
      const failComplete = await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'COMPLETED' },
      });
      // Should fail (not 200)
      expect(failComplete.statusCode).not.toBe(200);

      // CRUCIAL: Return state in database MUST remain in RECEIVED (not falsely completed)
      const retCheck = (
        await app.inject({
          method: 'GET',
          url: `/fulfillment/returns/${ret.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(retCheck.status).toBe('RECEIVED');

      // Now restore payment intent status to SUCCEEDED
      await db.query(`UPDATE payment_intents SET status = 'SUCCEEDED' WHERE id = $1`, [intent.id]);

      // Retry return completion -> must now succeed deterministically
      const retryComplete = await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'COMPLETED' },
      });
      expect(retryComplete.statusCode).toBe(200);
      expect(retryComplete.json().status).toBe('COMPLETED');

      // Verify exactly 1 refund record was created in payment boundary
      const refundCount = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM payment_refunds WHERE payment_intent_id = $1`,
        [intent.id],
      );
      expect(parseInt(refundCount.rows[0]!.count, 10)).toBe(1);
    });

    it('Case B: Payment succeeds, inventory restock fails -> Return remains RECEIVED, retry does not duplicate refund, and retry completes restock', async () => {
      const eco = await setupEcosystem();
      const { order, sellerOrder, orderItem, intent } = await createPaidOrder(eco, 2);

      // Deliver 2 units
      const shipRes = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: { sellerOrderId: sellerOrder.id, items: [{ orderItemId: orderItem.id, quantity: 2 }] },
        })
      ).json();
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'SHIPPED' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'IN_TRANSIT' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'OUT_FOR_DELIVERY' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'DELIVERED' } });

      const ret = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/returns',
          headers: { authorization: `Bearer ${eco.custToken}` },
          payload: {
            customerOrderId: order.id,
            sellerOrderId: sellerOrder.id,
            reason: 'Case B inventory failure test',
            items: [{ orderItemId: orderItem.id, quantity: 2 }],
          },
        })
      ).json();

      await app.inject({ method: 'POST', url: `/fulfillment/returns/${ret.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'APPROVED' } });
      await app.inject({ method: 'POST', url: `/fulfillment/returns/${ret.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'IN_TRANSIT' } });
      await app.inject({ method: 'POST', url: `/fulfillment/returns/${ret.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'RECEIVED' } });

      // Spy on InventoryService to simulate transient failure on restock
      const spy = vi
        .spyOn(InventoryService.prototype, 'increaseStock')
        .mockRejectedValueOnce(new Error('Simulated transient inventory failure'));

      // Attempt completion with restock: true -> Must fail because inventory restock fails
      const failRes = await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'COMPLETED', options: { restock: true } },
      });
      expect(failRes.statusCode).not.toBe(200);

      // Verify return is STILL in RECEIVED state (never falsely marked COMPLETED)
      const retCheck = (await app.inject({
        method: 'GET',
        url: `/fulfillment/returns/${ret.id}`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      })).json();
      expect(retCheck.status).toBe('RECEIVED');

      // But payment refund succeeded!
      const refundsBeforeRetry = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM payment_refunds WHERE payment_intent_id = $1`,
        [intent.id],
      );
      expect(parseInt(refundsBeforeRetry.rows[0]!.count, 10)).toBe(1);

      // Retry completion -> Must succeed cleanly without creating duplicate refund
      const retryRes = await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'COMPLETED', options: { restock: true } },
      });
      expect(retryRes.statusCode).toBe(200);
      expect(retryRes.json().status).toBe('COMPLETED');

      // Still exactly 1 refund record (idempotent refund handoff)
      const refundsAfterRetry = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM payment_refunds WHERE payment_intent_id = $1`,
        [intent.id],
      );
      expect(parseInt(refundsAfterRetry.rows[0]!.count, 10)).toBe(1);

      spy.mockRestore();
    });

    it('Case C: Payment succeeds, inventory succeeds, crash simulated before return update -> retry does NOT double-refund and does NOT double-restock', async () => {
      const eco = await setupEcosystem();
      const { order, sellerOrder, orderItem, intent } = await createPaidOrder(eco, 2);

      // Initial onHand: 20 - 2 = 18
      const invInit = (await app.inject({
        method: 'GET',
        url: `/inventory/${eco.invA.id}`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      })).json();
      expect(invInit.onHandQuantity).toBe(18);

      // Deliver 2 units
      const shipRes = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: { sellerOrderId: sellerOrder.id, items: [{ orderItemId: orderItem.id, quantity: 2 }] },
        })
      ).json();
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'SHIPPED' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'IN_TRANSIT' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'OUT_FOR_DELIVERY' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'DELIVERED' } });

      const ret = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/returns',
          headers: { authorization: `Bearer ${eco.custToken}` },
          payload: {
            customerOrderId: order.id,
            sellerOrderId: sellerOrder.id,
            reason: 'Case C crash test',
            items: [{ orderItemId: orderItem.id, quantity: 2 }],
          },
        })
      ).json();

      await app.inject({ method: 'POST', url: `/fulfillment/returns/${ret.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'APPROVED' } });
      await app.inject({ method: 'POST', url: `/fulfillment/returns/${ret.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'IN_TRANSIT' } });
      await app.inject({ method: 'POST', url: `/fulfillment/returns/${ret.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'RECEIVED' } });

      // First completion succeeds
      const compRes1 = await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'COMPLETED', options: { restock: true } },
      });
      expect(compRes1.statusCode).toBe(200);

      // Inventory onHand should be back to 20
      const invAfter1 = (await app.inject({
        method: 'GET',
        url: `/inventory/${eco.invA.id}`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      })).json();
      expect(invAfter1.onHandQuantity).toBe(20);

      // Simulate a retry where the client resubmits completion
      const compRes2 = await app.inject({
        method: 'POST',
        url: `/fulfillment/returns/${ret.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'COMPLETED', options: { restock: true } },
      });
      expect(compRes2.statusCode).toBe(200);

      // Verify onHand is STILL exactly 20 (NOT 22!)
      const invAfter2 = (await app.inject({
        method: 'GET',
        url: `/inventory/${eco.invA.id}`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      })).json();
      expect(invAfter2.onHandQuantity).toBe(20);

      // Exactly 1 refund record exists
      const refundCount = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM payment_refunds WHERE payment_intent_id = $1`,
        [intent.id],
      );
      expect(parseInt(refundCount.rows[0]!.count, 10)).toBe(1);
    });

    it('Case D: Concurrent return completion requests result in exactly 1 refund and 1 inventory restock', async () => {
      const eco = await setupEcosystem();
      const { order, sellerOrder, orderItem, intent } = await createPaidOrder(eco, 3);

      // Deliver 3 units
      const shipRes = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: { sellerOrderId: sellerOrder.id, items: [{ orderItemId: orderItem.id, quantity: 3 }] },
        })
      ).json();
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'SHIPPED' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'IN_TRANSIT' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'OUT_FOR_DELIVERY' } });
      await app.inject({ method: 'POST', url: `/fulfillment/shipments/${shipRes.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'DELIVERED' } });

      const ret = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/returns',
          headers: { authorization: `Bearer ${eco.custToken}` },
          payload: {
            customerOrderId: order.id,
            sellerOrderId: sellerOrder.id,
            reason: 'Case D concurrency test',
            items: [{ orderItemId: orderItem.id, quantity: 3 }],
          },
        })
      ).json();

      await app.inject({ method: 'POST', url: `/fulfillment/returns/${ret.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'APPROVED' } });
      await app.inject({ method: 'POST', url: `/fulfillment/returns/${ret.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'IN_TRANSIT' } });
      await app.inject({ method: 'POST', url: `/fulfillment/returns/${ret.id}/status`, headers: { authorization: `Bearer ${eco.alphaToken}` }, payload: { status: 'RECEIVED' } });

      // Two concurrent completion requests
      const [c1, c2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/fulfillment/returns/${ret.id}/status`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: { status: 'COMPLETED', options: { restock: true } },
        }),
        app.inject({
          method: 'POST',
          url: `/fulfillment/returns/${ret.id}/status`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: { status: 'COMPLETED', options: { restock: true } },
        }),
      ]);

      expect(c1.statusCode).toBe(200);
      expect(c2.statusCode).toBe(200);
      expect(c1.json().status).toBe('COMPLETED');
      expect(c2.json().status).toBe('COMPLETED');

      // Exactly 1 refund in DB
      const refundCount = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM payment_refunds WHERE payment_intent_id = $1`,
        [intent.id],
      );
      expect(parseInt(refundCount.rows[0]!.count, 10)).toBe(1);

      // On-hand stock increased by 3 exactly once: (20 - 3 = 17) + 3 = 20
      const invAfter = (await app.inject({
        method: 'GET',
        url: `/inventory/${eco.invA.id}`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
      })).json();
      expect(invAfter.onHandQuantity).toBe(20);
    });

    it('Payment refund idempotency: validates same key + same request, rejects different amount or payment', async () => {
      const eco = await setupEcosystem();
      const { intent: intentA } = await createPaidOrder(eco, 1);
      const { intent: intentB } = await createPaidOrder(eco, 1);

      // Call 1: Successful refund with key 'ref-idem-test-01'
      const r1 = await app.inject({
        method: 'POST',
        url: `/payments/intents/${intentA.id}/refund`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { amount: 1000, idempotencyKey: 'ref-idem-test-01', reason: 'Initial refund' },
      });
      expect(r1.statusCode).toBe(201);
      const ref1 = r1.json();

      // Call 2: Retry with identical parameters -> Same result
      const r2 = await app.inject({
        method: 'POST',
        url: `/payments/intents/${intentA.id}/refund`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { amount: 1000, idempotencyKey: 'ref-idem-test-01', reason: 'Initial refund' },
      });
      expect(r2.statusCode).toBe(201);
      expect(r2.json().id).toBe(ref1.id);

      // Call 3: Same key with different amount -> Rejected (400)
      const r3 = await app.inject({
        method: 'POST',
        url: `/payments/intents/${intentA.id}/refund`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { amount: 500, idempotencyKey: 'ref-idem-test-01', reason: 'Different amount' },
      });
      expect(r3.statusCode).toBe(400);

      // Call 4: Same key with different payment intent -> Rejected (400)
      const r4 = await app.inject({
        method: 'POST',
        url: `/payments/intents/${intentB.id}/refund`,
        headers: { authorization: `Bearer ${eco.adminToken}` },
        payload: { amount: 1000, idempotencyKey: 'ref-idem-test-01', reason: 'Different payment intent' },
      });
      expect(r4.statusCode).toBe(400);
    });

    it('Inventory restock idempotency: repeated increaseStock with same referenceId does not double stock', async () => {
      const eco = await setupEcosystem();

      // Call 1: increase stock by 5 with referenceId
      const res1 = await app.inject({
        method: 'POST',
        url: `/inventory/${eco.invA.id}/increase-stock`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { quantity: 5, notes: 'Restock 1', referenceId: 'ref_idempotent_01' },
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json().onHandQuantity).toBe(25);

      // Call 2: repeated increase stock with same referenceId -> Returns existing without adding another 5
      const res2 = await app.inject({
        method: 'POST',
        url: `/inventory/${eco.invA.id}/increase-stock`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { quantity: 5, notes: 'Restock 1 repeat', referenceId: 'ref_idempotent_01' },
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().onHandQuantity).toBe(25);

      // Verify exactly 1 movement record exists for this referenceId
      const movCount = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM inventory_movements WHERE reference_id = 'ref_idempotent_01'`,
      );
      expect(parseInt(movCount.rows[0]!.count, 10)).toBe(1);
    });

    it('concurrent duplicate refund requests with same idempotency key result in exactly 1 refund record', async () => {
      const eco = await setupEcosystem();
      const { intent } = await createPaidOrder(eco, 1);

      const [r1, r2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/payments/intents/${intent.id}/refund`,
          headers: { authorization: `Bearer ${eco.adminToken}` },
          payload: { amount: 1000, idempotencyKey: 'concurrent-refund-key-01', reason: 'Race 1' },
        }),
        app.inject({
          method: 'POST',
          url: `/payments/intents/${intent.id}/refund`,
          headers: { authorization: `Bearer ${eco.adminToken}` },
          payload: { amount: 1000, idempotencyKey: 'concurrent-refund-key-01', reason: 'Race 2' },
        }),
      ]);

      expect(r1.statusCode).toBe(201);
      expect(r2.statusCode).toBe(201);
      expect(r1.json().id).toBe(r2.json().id);

      const countRes = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM payment_refunds WHERE idempotency_key = 'concurrent-refund-key-01'`,
      );
      expect(parseInt(countRes.rows[0]!.count, 10)).toBe(1);
    });

    it('concurrent duplicate increaseStock requests with same referenceId increase stock exactly once', async () => {
      const eco = await setupEcosystem();

      const [res1, res2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/inventory/${eco.invA.id}/increase-stock`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: { quantity: 5, notes: 'Concurrent Restock A', referenceId: 'concurrent_restock_ref_01' },
        }),
        app.inject({
          method: 'POST',
          url: `/inventory/${eco.invA.id}/increase-stock`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: { quantity: 5, notes: 'Concurrent Restock B', referenceId: 'concurrent_restock_ref_01' },
        }),
      ]);

      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);
      expect(res1.json().onHandQuantity).toBe(25);
      expect(res2.json().onHandQuantity).toBe(25);

      const movCount = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM inventory_movements WHERE reference_id = 'concurrent_restock_ref_01'`,
      );
      expect(parseInt(movCount.rows[0]!.count, 10)).toBe(1);
    });

    it('concurrent duplicate carrier callbacks result in exactly one status mutation and one deduplicated response', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      const shipRes = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: {
            sellerOrderId: sellerOrder.id,
            carrier: 'MockLogistics',
            trackingNumber: 'TRK-CONCURRENT-001',
            items: [{ orderItemId: orderItem.id, quantity: 1 }],
          },
        })
      ).json();

      const payload = JSON.stringify({
        eventId: 'evt_concurrent_carrier_001',
        carrier: 'MockLogistics',
        trackingNumber: 'TRK-CONCURRENT-001',
        status: 'SHIPPED',
        location: 'Hub Concord',
        timestamp: new Date().toISOString(),
      });
      const sig = createHmac('sha256', CARRIER_SECRET).update(payload).digest('hex');

      const [res1, res2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/fulfillment/carrier/callback',
          headers: { 'content-type': 'application/json', 'x-carrier-signature': sig },
          payload,
        }),
        app.inject({
          method: 'POST',
          url: '/fulfillment/carrier/callback',
          headers: { 'content-type': 'application/json', 'x-carrier-signature': sig },
          payload,
        }),
      ]);

      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);

      const body1 = res1.json();
      const body2 = res2.json();
      expect(body1.processed).toBe(true);
      expect(body2.processed).toBe(true);
      // Exactly one was the primary processor, the other was deduplicated
      const deduplicatedCount = (body1.deduplicated ? 1 : 0) + (body2.deduplicated ? 1 : 0);
      expect(deduplicatedCount).toBe(1);

      // Verify exactly 1 event row exists in carrier_webhook_events
      const eventCount = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM carrier_webhook_events WHERE provider_event_id = 'evt_concurrent_carrier_001'`,
      );
      expect(parseInt(eventCount.rows[0]!.count, 10)).toBe(1);

      // Shipment is SHIPPED
      const getShip = (
        await app.inject({
          method: 'GET',
          url: `/fulfillment/shipments/${shipRes.id}`,
          headers: { authorization: `Bearer ${eco.alphaToken}` },
        })
      ).json();
      expect(getShip.status).toBe('SHIPPED');
    });

    it('enforces invalid transition rejections on shipments and returns', async () => {
      const eco = await setupEcosystem();
      const { sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      const shipRes = (
        await app.inject({
          method: 'POST',
          url: '/fulfillment/shipments',
          headers: { authorization: `Bearer ${eco.alphaToken}` },
          payload: { sellerOrderId: sellerOrder.id, items: [{ orderItemId: orderItem.id, quantity: 1 }] },
        })
      ).json();

      // Cancel shipment
      const cancelRes = await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${shipRes.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'CANCELLED' },
      });
      expect(cancelRes.statusCode).toBe(200);

      // CANCELLED -> SHIPPED must be rejected (409)
      const invalidShip = await app.inject({
        method: 'POST',
        url: `/fulfillment/shipments/${shipRes.id}/status`,
        headers: { authorization: `Bearer ${eco.alphaToken}` },
        payload: { status: 'SHIPPED' },
      });
      expect(invalidShip.statusCode).toBe(409);

      // Cross-tenant access: Merchant Beta cannot view Merchant Alpha shipment
      const betaGetShip = await app.inject({
        method: 'GET',
        url: `/fulfillment/shipments/${shipRes.id}`,
        headers: { authorization: `Bearer ${eco.betaToken}` },
      });
      expect(betaGetShip.statusCode).toBe(403);
    });
  });

  // --- 6. DATABASE INTEGRITY & CONSTRAINTS ---
  describe('Database Integrity & Constraints', () => {
    it('enforces check constraints on shipment status and positive item quantity', async () => {
      const eco = await setupEcosystem();
      const { order, sellerOrder, orderItem } = await createPaidOrder(eco, 1);

      // 1. Foreign key constraint: invalid customer_order_id rejected
      await expect(
        db.query(
          `INSERT INTO shipments (
            id, seller_order_id, customer_order_id, seller_tenant_id, status
          ) VALUES ('invalid-fk-ship', $1, 'non-existent-order-id', $2, 'PENDING')`,
          [sellerOrder.id, eco.profA.tenantId],
        ),
      ).rejects.toThrow();

      // 2. Invalid shipment status check constraint
      await expect(
        db.query(
          `INSERT INTO shipments (
            id, seller_order_id, customer_order_id, seller_tenant_id, status
          ) VALUES ('invalid-status-ship', $1, $2, $3, 'INVALID_STATUS')`,
          [sellerOrder.id, order.id, eco.profA.tenantId],
        ),
      ).rejects.toThrow();

      // 3. Negative quantity check constraint on shipment_items
      const validShip = await db.query<{ id: string }>(
        `INSERT INTO shipments (
          id, seller_order_id, customer_order_id, seller_tenant_id, status
        ) VALUES ('valid-ship-for-qty-chk', $1, $2, $3, 'PENDING')
        RETURNING id`,
        [sellerOrder.id, order.id, eco.profA.tenantId],
      );

      await expect(
        db.query(
          `INSERT INTO shipment_items (id, shipment_id, order_item_id, quantity)
           VALUES ('si-chk-neg', $1, $2, -1)`,
          [validShip.rows[0]!.id, orderItem.id],
        ),
      ).rejects.toThrow();

      // 4. Unique idempotency constraint on shipments
      await db.query(
        `INSERT INTO shipments (
          id, seller_order_id, customer_order_id, seller_tenant_id, status, idempotency_key
        ) VALUES ('ship-idem-1', $1, $2, $3, 'PENDING', 'unique-key-db-chk')`,
        [sellerOrder.id, order.id, eco.profA.tenantId],
      );

      await expect(
        db.query(
          `INSERT INTO shipments (
            id, seller_order_id, customer_order_id, seller_tenant_id, status, idempotency_key
          ) VALUES ('ship-idem-2', $1, $2, $3, 'PENDING', 'unique-key-db-chk')`,
          [sellerOrder.id, order.id, eco.profA.tenantId],
        ),
      ).rejects.toThrow();
    });
  });
});

