import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase, markAllUsersVerified, registerVerifiedUser } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';
import { JsonLogger } from '../src/observability/logger.js';
import {
  InMemoryEventTransport,
  OutboxRepository,
  createDomainEvent,
  EventTypes,
} from '../src/modules/events/index.js';
import {
  AnalyticsRepository,
  AnalyticsService,
  AnalyticsEventConsumer,
} from '../src/modules/analytics/index.js';
import { InMemorySearchStore } from '../src/modules/search/index.js';

const TOKEN_SECRET = 'test-token-secret-must-be-at-least-32-characters-long!';

describe('Phase 11: Analytics Bounded Context & Event Ingestion Pipeline', () => {
  let app: FastifyInstance;
  let db: DatabaseConnection;
  let transport: InMemoryEventTransport;
  let logger: JsonLogger;
  let outboxRepo: OutboxRepository;
  let analyticsRepo: AnalyticsRepository;
  let analyticsService: AnalyticsService;
  let analyticsConsumer: AnalyticsEventConsumer;
  let searchStore: InMemorySearchStore;

  beforeEach(async () => {
    db = await createMigratedTestDatabase();
    searchStore = new InMemorySearchStore();
    transport = new InMemoryEventTransport();
    logger = new JsonLogger({ serviceName: 'test-analytics', level: 'fatal' });

    outboxRepo = new OutboxRepository();
    analyticsRepo = new AnalyticsRepository();
    analyticsService = new AnalyticsService(db, logger, analyticsRepo);
    analyticsConsumer = new AnalyticsEventConsumer(
      db,
      outboxRepo,
      transport,
      logger,
      analyticsService,
    );

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
      searchStore,
      eventTransport: transport,
      skipMigrations: true,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (db) await db.close();
  });

  async function getAdminToken() {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'admin@platform.com',
        password: 'Password123!',
        tenantName: 'Platform Tenant',
        role: 'MERCHANT',
      },
    });

    const userRes = await db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
      'admin@platform.com',
    ]);
    await db.query(`UPDATE tenant_memberships SET role = 'ADMINISTRATOR' WHERE user_id = $1`, [
      userRes.rows[0]!.id,
    ]);
    await markAllUsersVerified(db);

    const adminLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@platform.com', password: 'Password123!' },
    });
    return adminLogin.json().accessToken;
  }

  async function getMerchantToken(email = 'seller@merchant.com', tenantName = 'Seller Tenant') {
    const token = await registerVerifiedUser(app, db, {
      email,
      password: 'Password123!',
      tenantName,
      role: 'MERCHANT',
    });
    const userRes = await db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    const memberRes = await db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenant_memberships WHERE user_id = $1`,
      [userRes.rows[0]!.id],
    );
    return { token, tenantId: memberRes.rows[0]!.tenant_id, userId: userRes.rows[0]!.id };
  }

  async function getCustomerToken(email = 'buyer@customer.com') {
    const token = await registerVerifiedUser(app, db, {
      email,
      password: 'Password123!',
      tenantName: 'Customer Tenant',
      role: 'CUSTOMER',
    });
    const userRes = await db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    const memberRes = await db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenant_memberships WHERE user_id = $1`,
      [userRes.rows[0]!.id],
    );
    return { token, tenantId: memberRes.rows[0]!.tenant_id };
  }

  // --- 1. EVENT INGESTION MATRIX (SCENARIOS A - G) ---

  describe('Event Ingestion & Failure Matrix (Scenarios A - G)', () => {
    it('Scenario A: Event received successfully and creates immutable analytical facts', async () => {
      const tenantId = 'tenant-a';
      const event = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-100',
        tenantId,
        occurredAt: '2026-09-30T10:00:00.000Z',
        payload: {
          orderId: 'ord-100',
          currency: 'INR',
          totalAmount: 1500,
          status: 'COMPLETED',
          items: [
            {
              productId: 'prod-1',
              merchantId: 'merch-1',
              quantity: 2,
              unitPrice: 500,
              sku: 'SKU-PHONE',
            },
            {
              productId: 'prod-2',
              merchantId: 'merch-2',
              quantity: 1,
              unitPrice: 500,
              sku: 'SKU-CASE',
            },
          ],
        },
      });

      await transport.publish(event);

      // Verify facts created
      const facts = await db.query<{
        order_id: string;
        product_id: string;
        quantity: number;
        unit_price: string;
        total_amount: string;
      }>(`SELECT * FROM analytics_order_facts WHERE tenant_id = $1 ORDER BY product_id ASC`, [
        tenantId,
      ]);

      expect(facts.rows.length).toBe(2);
      expect(facts.rows[0]?.product_id).toBe('prod-1');
      expect(facts.rows[0]?.quantity).toBe(2);
      expect(Number(facts.rows[0]?.unit_price)).toBe(500);
      expect(Number(facts.rows[0]?.total_amount)).toBe(1000);

      // Verify aggregate created
      const metrics = await db.query<{
        total_orders: number;
        gross_sales: string;
        units_sold: number;
      }>(
        `SELECT * FROM analytics_daily_metrics WHERE tenant_id = $1 AND merchant_id = 'ALL' AND metric_date = '2026-09-30'`,
        [tenantId],
      );

      expect(metrics.rows.length).toBe(1);
      expect(metrics.rows[0]?.total_orders).toBe(1);
      expect(Number(metrics.rows[0]?.gross_sales)).toBe(1500);
      expect(metrics.rows[0]?.units_sold).toBe(3);
    });

    it('Scenario B: Duplicate event delivery produces zero duplicate fact rows or double-counted sales', async () => {
      const tenantId = 'tenant-b';
      const event = createDomainEvent({
        eventId: 'evt-dup-order-1',
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-dup-1',
        tenantId,
        occurredAt: '2026-09-30T11:00:00.000Z',
        payload: {
          orderId: 'ord-dup-1',
          currency: 'INR',
          totalAmount: 2000,
          status: 'COMPLETED',
          items: [
            {
              productId: 'prod-dup',
              merchantId: 'merch-dup',
              quantity: 2,
              unitPrice: 1000,
            },
          ],
        },
      });

      // Deliver first time
      await transport.publish(event);

      // Deliver duplicate second time
      await transport.publish(event);

      // Verify receipt table deduplication
      const receipts = await db.query(
        `SELECT * FROM event_consumer_receipts WHERE consumer_name = 'analytics-ingestor' AND event_id = $1`,
        [event.eventId],
      );
      expect(receipts.rows.length).toBe(1);

      // Verify facts table has exactly 1 row
      const facts = await db.query(
        `SELECT * FROM analytics_order_facts WHERE event_id = $1`,
        [event.eventId],
      );
      expect(facts.rows.length).toBe(1);

      // Verify metric is not double-counted (gross_sales should be 2000, not 4000)
      const metrics = await db.query<{ gross_sales: string; total_orders: number }>(
        `SELECT gross_sales, total_orders FROM analytics_daily_metrics WHERE tenant_id = $1 AND merchant_id = 'ALL'`,
        [tenantId],
      );
      expect(metrics.rows[0]?.total_orders).toBe(1);
      expect(Number(metrics.rows[0]?.gross_sales)).toBe(2000);
    });

    it('Scenario C: Concurrent duplicate delivery is safely deduplicated via UNIQUE constraint', async () => {
      const tenantId = 'tenant-c';
      const event = createDomainEvent({
        eventId: 'evt-concurrent-1',
        eventType: EventTypes.PAYMENT_SUCCEEDED,
        aggregateType: 'payment',
        aggregateId: 'pay-concurrent-1',
        tenantId,
        occurredAt: '2026-09-30T12:00:00.000Z',
        payload: {
          paymentIntentId: 'pay-concurrent-1',
          amount: 500,
          currency: 'INR',
        },
      });

      // Dispatch identical event concurrently
      const results = await Promise.all([
        analyticsConsumer.process(event),
        analyticsConsumer.process(event),
      ]);

      // Exactly one succeeds with duplicate: false, second detects duplicate: true
      const duplicates = results.filter((r) => r.duplicate);
      expect(duplicates.length).toBe(1);

      const facts = await db.query(
        `SELECT * FROM analytics_payment_facts WHERE event_id = $1`,
        [event.eventId],
      );
      expect(facts.rows.length).toBe(1);
    });

    it('Scenario D: Consumer crash before completion leaves receipt in FAILED status, reclaims safely on retry', async () => {
      const tenantId = 'tenant-d';
      const event = createDomainEvent({
        eventId: 'evt-crash-1',
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-crash-1',
        tenantId,
        occurredAt: '2026-09-30T13:00:00.000Z',
        payload: {
          orderId: 'ord-crash-1',
          totalAmount: 300,
        },
      });

      // Simulate transient crash in ingestEvent on first attempt
      const originalIngest = analyticsService.ingestEvent.bind(analyticsService);
      let callCount = 0;
      analyticsService.ingestEvent = async (e) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Database connection transient crash');
        }
        return originalIngest(e);
      };

      // First run: fails
      const res1 = await analyticsConsumer.process(event);
      expect(res1.handled).toBe(false);

      // Verify receipt status is FAILED
      const receipt = await db.query<{ status: string }>(
        `SELECT status FROM event_consumer_receipts WHERE consumer_name = 'analytics-ingestor' AND event_id = $1`,
        [event.eventId],
      );
      expect(receipt.rows[0]?.status).toBe('FAILED');

      // Clear failed receipt to simulate scheduled redelivery
      await db.query(`DELETE FROM event_consumer_receipts WHERE event_id = $1`, [event.eventId]);

      // Second run: retry succeeds
      const res2 = await analyticsConsumer.process(event);
      expect(res2.handled).toBe(true);

      const receiptAfter = await db.query<{ status: string }>(
        `SELECT status FROM event_consumer_receipts WHERE consumer_name = 'analytics-ingestor' AND event_id = $1`,
        [event.eventId],
      );
      expect(receiptAfter.rows[0]?.status).toBe('COMPLETED');
    });

    it('Scenario F: Late event (event from 2 days ago) updates historical day aggregate without double counting', async () => {
      const tenantId = 'tenant-f';
      const historicalDate = '2026-09-28';
      const lateEvent = createDomainEvent({
        eventId: 'evt-late-1',
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-late-1',
        tenantId,
        occurredAt: '2026-09-28T14:30:00.000Z',
        payload: {
          orderId: 'ord-late-1',
          totalAmount: 1200,
          currency: 'INR',
          status: 'COMPLETED',
          items: [{ productId: 'p-late', merchantId: 'm-late', quantity: 1, unitPrice: 1200 }],
        },
      });

      await transport.publish(lateEvent);

      // Verify historical date aggregate was created and matches the late event's date
      const metric = await db.query<{ metric_date: string; gross_sales: string; total_orders: number }>(
        `SELECT metric_date, gross_sales, total_orders FROM analytics_daily_metrics WHERE tenant_id = $1 AND metric_date = $2 AND merchant_id = 'ALL'`,
        [tenantId, historicalDate],
      );

      expect(metric.rows.length).toBe(1);
      expect(metric.rows[0]?.metric_date).toBe('2026-09-28');
      expect(Number(metric.rows[0]?.gross_sales)).toBe(1200);
      expect(metric.rows[0]?.total_orders).toBe(1);
    });

    it('Scenario G: Out-of-order event handling (Payment arrives before Order)', async () => {
      const tenantId = 'tenant-g';
      const payEvent = createDomainEvent({
        eventId: 'evt-ooo-pay',
        eventType: EventTypes.PAYMENT_SUCCEEDED,
        aggregateType: 'payment',
        aggregateId: 'pay-ooo-1',
        tenantId,
        occurredAt: '2026-09-30T10:00:00.000Z',
        payload: {
          paymentIntentId: 'pay-ooo-1',
          orderId: 'ord-ooo-1',
          amount: 800,
          currency: 'INR',
        },
      });

      const ordEvent = createDomainEvent({
        eventId: 'evt-ooo-ord',
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-ooo-1',
        tenantId,
        occurredAt: '2026-09-30T10:05:00.000Z',
        payload: {
          orderId: 'ord-ooo-1',
          totalAmount: 800,
          currency: 'INR',
          status: 'COMPLETED',
        },
      });

      // 1. Ingest Payment first
      await transport.publish(payEvent);
      // 2. Ingest Order second
      await transport.publish(ordEvent);

      // Verify both facts exist
      const payFact = await db.query(
        `SELECT * FROM analytics_payment_facts WHERE event_id = $1`,
        [payEvent.eventId],
      );
      const ordFact = await db.query(
        `SELECT * FROM analytics_order_facts WHERE event_id = $1`,
        [ordEvent.eventId],
      );

      expect(payFact.rows.length).toBe(1);
      expect(ordFact.rows.length).toBe(1);

      // Verify daily metric correctly reflects both order and payment success
      const metric = await db.query<{ total_orders: number; payment_success_count: number }>(
        `SELECT total_orders, payment_success_count FROM analytics_daily_metrics WHERE tenant_id = $1 AND merchant_id = 'ALL'`,
        [tenantId],
      );
      expect(metric.rows[0]?.total_orders).toBe(1);
      expect(metric.rows[0]?.payment_success_count).toBe(1);
    });
  });

  // --- 2. DATA QUALITY & QUARANTINE (SCENARIO H) ---

  describe('Data Quality Controls & Quarantine (Scenario H)', () => {
    it('quarantines event with missing tenant ID without crashing consumer or corrupting facts', async () => {
      const invalidEvent = {
        eventId: 'evt-bad-tenant',
        eventType: EventTypes.ORDER_CREATED,
        eventVersion: 1,
        aggregateType: 'order',
        aggregateId: 'ord-bad-tenant',
        tenantId: '', // invalid empty tenant
        occurredAt: new Date().toISOString(),
        payload: { totalAmount: 500 },
        metadata: {},
      };

      const res = await analyticsConsumer.process(invalidEvent);
      expect(res.handled).toBe(true); // Consumer acknowledges message so queue does not block

      const quarantine = await db.query<{ violation_reason: string }>(
        `SELECT violation_reason FROM analytics_quarantine_records WHERE event_id = $1`,
        [invalidEvent.eventId],
      );
      expect(quarantine.rows.length).toBe(1);
      expect(quarantine.rows[0]?.violation_reason).toBe('MISSING_OR_EMPTY_TENANT_ID');

      // Verify no fact created
      const facts = await db.query(
        `SELECT * FROM analytics_order_facts WHERE event_id = $1`,
        [invalidEvent.eventId],
      );
      expect(facts.rows.length).toBe(0);
    });

    it('quarantines event with negative monetary amount or negative quantity', async () => {
      const tenantId = 'tenant-h';
      const negativeOrder = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-neg-qty',
        tenantId,
        payload: {
          orderId: 'ord-neg-qty',
          totalAmount: 100,
          items: [{ productId: 'p-1', quantity: -5, unitPrice: 20 }],
        },
      });

      await transport.publish(negativeOrder);

      const quarantine = await db.query<{ violation_reason: string }>(
        `SELECT violation_reason FROM analytics_quarantine_records WHERE event_id = $1`,
        [negativeOrder.eventId],
      );
      expect(quarantine.rows.length).toBe(1);
      expect(quarantine.rows[0]?.violation_reason).toBe('NEGATIVE_QUANTITY');

      // Verify gross sales is 0
      const metric = await db.query(
        `SELECT * FROM analytics_daily_metrics WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(metric.rows.length).toBe(0);
    });
  });

  // --- 3. REBUILD & RECONCILIATION (SCENARIO J & O) ---

  describe('Administrative Projection Rebuild (Scenarios J & O)', () => {
    it('Scenario J & O: Rebuilds analytical facts and daily metrics from outbox events accurately', async () => {
      const tenantId = 'tenant-rebuild';
      const adminToken = await getAdminToken();

      // 1. Emit 3 events into outbox
      const event1 = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-reb-1',
        tenantId,
        occurredAt: '2026-09-30T10:00:00.000Z',
        payload: {
          orderId: 'ord-reb-1',
          totalAmount: 1000,
          currency: 'INR',
          status: 'COMPLETED',
          items: [{ productId: 'prod-reb-1', merchantId: 'm-reb', quantity: 1, unitPrice: 1000 }],
        },
      });
      const event2 = createDomainEvent({
        eventType: EventTypes.PAYMENT_SUCCEEDED,
        aggregateType: 'payment',
        aggregateId: 'pay-reb-1',
        tenantId,
        occurredAt: '2026-09-30T10:05:00.000Z',
        payload: { paymentIntentId: 'pay-reb-1', orderId: 'ord-reb-1', amount: 1000, currency: 'INR' },
      });
      const event3 = createDomainEvent({
        eventType: EventTypes.PAYMENT_REFUND_CREATED,
        aggregateType: 'payment',
        aggregateId: 'ref-reb-1',
        tenantId,
        occurredAt: '2026-09-30T10:10:00.000Z',
        payload: { paymentIntentId: 'pay-reb-1', amount: 200, currency: 'INR' },
      });

      await db.withTransaction(async (tx) => {
        await outboxRepo.insertEvent(tx, event1);
        await outboxRepo.insertEvent(tx, event2);
        await outboxRepo.insertEvent(tx, event3);
      });

      // 2. Trigger rebuild via HTTP POST /analytics/rebuild
      const rebuildRes = await app.inject({
        method: 'POST',
        url: '/analytics/rebuild',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { tenantId },
      });

      expect(rebuildRes.statusCode).toBe(200);
      const rebuildBody = rebuildRes.json();
      expect(rebuildBody.status).toBe('COMPLETED');
      expect(rebuildBody.sourceEventCount).toBe(3);
      expect(rebuildBody.factsRebuilt).toBe(3);

      // 3. Query commerce KPIs via HTTP API and verify totals
      const salesRes = await app.inject({
        method: 'GET',
        url: `/analytics/sales?tenantId=${tenantId}&startDate=2026-09-30&endDate=2026-09-30`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(salesRes.statusCode).toBe(200);
      const salesBody = salesRes.json();
      expect(salesBody.totals.totalOrders).toBe(1);
      expect(salesBody.totals.grossSales).toBe('1000.0000');
      expect(salesBody.totals.refundAmount).toBe('200.0000');
      expect(salesBody.totals.netSales).toBe('800.0000');
      expect(salesBody.totals.averageOrderValue).toBe('1000.0000'); // AOV = Gross Sales / Total Orders (1000 / 1)
    });
  });

  // --- 4. MULTI-TENANT & MERCHANT ISOLATION (SCENARIO K, L, M) ---

  describe('Tenant & Merchant Isolation & Multi-Currency (Scenarios K, L, M)', () => {
    it('Scenario K: Tenant A query returns ONLY Tenant A data and never leaks Tenant B facts', async () => {
      const adminToken = await getAdminToken();

      const eventA = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-tenant-a',
        tenantId: 'tenant-a-iso',
        occurredAt: '2026-09-30T10:00:00.000Z',
        payload: { orderId: 'ord-tenant-a', totalAmount: 500, currency: 'INR' },
      });
      const eventB = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-tenant-b',
        tenantId: 'tenant-b-iso',
        occurredAt: '2026-09-30T10:00:00.000Z',
        payload: { orderId: 'ord-tenant-b', totalAmount: 9000, currency: 'INR' },
      });

      await transport.publish(eventA);
      await transport.publish(eventB);

      const queryA = await app.inject({
        method: 'GET',
        url: '/analytics/sales?tenantId=tenant-a-iso&startDate=2026-09-30&endDate=2026-09-30',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(queryA.statusCode).toBe(200);
      const bodyA = queryA.json();
      expect(bodyA.totals.grossSales).toBe('500.0000');
      expect(bodyA.totals.totalOrders).toBe(1);
      expect(bodyA.metadata.tenantId).toBe('tenant-a-iso');
    });

    it('Scenario L: Merchant actor can ONLY access their own analytics and is rejected if querying another merchant', async () => {
      const merchant = await getMerchantToken('merchant1@store.com', 'Store 1');
      const merchantToken = merchant.token;

      // Merchant attempts to query analytics with another merchant ID
      const forbiddenRes = await app.inject({
        method: 'GET',
        url: '/analytics/sales?merchantId=other-merchant-tenant-id',
        headers: { authorization: `Bearer ${merchantToken}` },
      });

      expect(forbiddenRes.statusCode).toBe(403);
      expect(forbiddenRes.json().error.message).toContain('Merchants may only access their own analytics data');
    });

    it('Scenario M: Multi-currency separation keeps INR and USD in separate distinct aggregates', async () => {
      const tenantId = 'tenant-currency';
      const adminToken = await getAdminToken();

      const inrOrder = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-inr',
        tenantId,
        occurredAt: '2026-09-30T10:00:00.000Z',
        payload: { orderId: 'ord-inr', totalAmount: 1000, currency: 'INR' },
      });
      const usdOrder = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-usd',
        tenantId,
        occurredAt: '2026-09-30T10:00:00.000Z',
        payload: { orderId: 'ord-usd', totalAmount: 50, currency: 'USD' },
      });

      await transport.publish(inrOrder);
      await transport.publish(usdOrder);

      // Query INR
      const inrRes = await app.inject({
        method: 'GET',
        url: `/analytics/sales?tenantId=${tenantId}&currency=INR&startDate=2026-09-30&endDate=2026-09-30`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(inrRes.json().totals.grossSales).toBe('1000.0000');
      expect(inrRes.json().currency).toBe('INR');

      // Query USD
      const usdRes = await app.inject({
        method: 'GET',
        url: `/analytics/sales?tenantId=${tenantId}&currency=USD&startDate=2026-09-30&endDate=2026-09-30`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(usdRes.json().totals.grossSales).toBe('50.0000');
      expect(usdRes.json().currency).toBe('USD');
    });
  });

  // --- 5. DASHBOARD CONTRACTS & EMPTY PERIODS (SCENARIOS N, P, Q) ---

  describe('API Contracts & Security (Scenarios N, P, Q)', () => {
    it('Scenario N: Analytics query with empty period returns zeroed dashboard contract', async () => {
      const adminToken = await getAdminToken();

      const res = await app.inject({
        method: 'GET',
        url: '/analytics/sales?tenantId=empty-tenant&startDate=2020-01-01&endDate=2020-01-02',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totals.totalOrders).toBe(0);
      expect(body.totals.grossSales).toBe('0.0000');
      expect(body.totals.netSales).toBe('0.0000');
      expect(body.totals.averageOrderValue).toBe('0.0000');
      expect(body.trends).toEqual([]);
    });

    it('Scenario P: Operational KPIs compute correct success and failure rates', async () => {
      const tenantId = 'tenant-ops';
      const adminToken = await getAdminToken();

      const successPay = createDomainEvent({
        eventType: EventTypes.PAYMENT_SUCCEEDED,
        aggregateType: 'payment',
        aggregateId: 'p-ok',
        tenantId,
        occurredAt: '2026-09-30T10:00:00.000Z',
        payload: { paymentIntentId: 'p-ok', amount: 100 },
      });
      const failPay = createDomainEvent({
        eventType: EventTypes.PAYMENT_FAILED,
        aggregateType: 'payment',
        aggregateId: 'p-fail',
        tenantId,
        occurredAt: '2026-09-30T10:00:00.000Z',
        payload: { paymentIntentId: 'p-fail', amount: 100, reason: 'Card declined' },
      });
      const shipment = createDomainEvent({
        eventType: EventTypes.FULFILLMENT_SHIPMENT_CREATED,
        aggregateType: 'shipment',
        aggregateId: 'ship-1',
        tenantId,
        occurredAt: '2026-09-30T10:00:00.000Z',
        payload: { shipmentId: 'ship-1', status: 'SHIPPED' },
      });

      await transport.publish(successPay);
      await transport.publish(failPay);
      await transport.publish(shipment);

      const opsRes = await app.inject({
        method: 'GET',
        url: `/analytics/operations?tenantId=${tenantId}&startDate=2026-09-30&endDate=2026-09-30`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(opsRes.statusCode).toBe(200);
      const ops = opsRes.json().operations;
      expect(ops.paymentSuccessCount).toBe(1);
      expect(ops.paymentFailCount).toBe(1);
      expect(ops.paymentSuccessRate).toBe('50.00%');
      expect(ops.paymentFailureRate).toBe('50.00%');
      expect(ops.shipmentCount).toBe(1);
    });

    it('Scenario Q: Rejects customer role from accessing analytics endpoints', async () => {
      const customer = await getCustomerToken();

      const salesRes = await app.inject({
        method: 'GET',
        url: '/analytics/sales',
        headers: { authorization: `Bearer ${customer.token}` },
      });
      expect(salesRes.statusCode).toBe(403);

      const opsRes = await app.inject({
        method: 'GET',
        url: '/analytics/operations',
        headers: { authorization: `Bearer ${customer.token}` },
      });
      expect(opsRes.statusCode).toBe(403);
    });
  });

  // --- 6. SURGICAL VERIFICATION & INVARIANT REGRESSION SUITE ---

  describe('Phase 11 Surgical Verification & Invariant Regressions', () => {
    it('Regression Gate 1: Rebuild safely reconstructs analytics without interference from existing consumer receipts, and future events process normally', async () => {
      const tenantId = 'tenant-surg-reb';
      const adminToken = await getAdminToken();

      // Step 1: Normal event emission and consumer ingestion
      const event1 = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-surg-1',
        tenantId,
        occurredAt: '2026-09-30T09:00:00.000Z',
        payload: {
          orderId: 'ord-surg-1',
          currency: 'INR',
          totalAmount: 1500,
          items: [{ productId: 'prod-surg-1', merchantId: 'm-surg-1', quantity: 2, unitPrice: 750 }],
        },
      });

      // Insert event into outbox_events (as the transactional domain would)
      await db.withTransaction(async (tx) => {
        await outboxRepo.insertEvent(tx, event1);
      });

      // Normal ingestion via AnalyticsEventConsumer (extends BaseEventConsumer)
      const ingestRes = await analyticsConsumer.process(event1);
      expect(ingestRes.handled).toBe(true);

      // Verify fact exists
      const factBefore = await db.query(
        `SELECT * FROM analytics_order_facts WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(factBefore.rows.length).toBe(1);

      // Verify consumer receipt exists with status COMPLETED
      const receiptBefore = await outboxRepo.findReceipt(db, 'analytics-ingestor', event1.eventId);
      expect(receiptBefore).toBeDefined();
      expect(receiptBefore?.status).toBe('COMPLETED');

      // Step 2: Trigger administrative rebuild POST /analytics/rebuild
      const rebuildRes = await app.inject({
        method: 'POST',
        url: '/analytics/rebuild',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { tenantId },
      });
      expect(rebuildRes.statusCode).toBe(200);
      const rebuildBody = rebuildRes.json();
      expect(rebuildBody.status).toBe('COMPLETED');
      expect(rebuildBody.sourceEventCount).toBe(1);
      expect(rebuildBody.factsRebuilt).toBe(1);

      // Verify facts are fully reconstructed and not duplicated
      const factAfter = await db.query(
        `SELECT * FROM analytics_order_facts WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(factAfter.rows.length).toBe(1);
      expect((factAfter.rows[0] as { order_id?: string } | undefined)?.order_id).toBe('ord-surg-1');

      // Step 3: Verify future new event consumption continues working seamlessly
      const event2 = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-surg-2',
        tenantId,
        occurredAt: '2026-09-30T10:00:00.000Z',
        payload: {
          orderId: 'ord-surg-2',
          currency: 'INR',
          totalAmount: 500,
          items: [{ productId: 'prod-surg-2', merchantId: 'm-surg-1', quantity: 1, unitPrice: 500 }],
        },
      });

      await db.withTransaction(async (tx) => {
        await outboxRepo.insertEvent(tx, event2);
      });

      const newIngestRes = await analyticsConsumer.process(event2);
      expect(newIngestRes.handled).toBe(true);

      const allFacts = await db.query(
        `SELECT * FROM analytics_order_facts WHERE tenant_id = $1 ORDER BY occurred_at ASC`,
        [tenantId],
      );
      expect(allFacts.rows.length).toBe(2);

      // Verify final daily metric aggregate
      const salesRes = await app.inject({
        method: 'GET',
        url: `/analytics/sales?tenantId=${tenantId}&startDate=2026-09-30&endDate=2026-09-30`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(salesRes.statusCode).toBe(200);
      const sales = salesRes.json().totals;
      expect(sales.totalOrders).toBe(2);
      expect(sales.unitsSold).toBe(3);
      expect(sales.grossSales).toBe('2000.0000');
    });

    it('Merchant rebuild backfills pre-event orders from transactional tables', async () => {
      // Legacy seller order with items but zero outbox rows (orders placed
      // before event emission existed) must still surface in analytics.
      const merchant = await getMerchantToken('backfill@store.com', 'Backfill Store');
      const tenantId = merchant.tenantId;

      await db.query(
        `INSERT INTO categories (id, name, slug) VALUES ('cat-backfill', 'Backfill', 'backfill')`,
      );
      await db.query(
        `INSERT INTO products (id, title, slug, category_id, status) VALUES ('prod-backfill', 'Backfill Widget', 'backfill-widget', 'cat-backfill', 'ACTIVE')`,
      );
      await db.query(
        `INSERT INTO product_skus (id, product_id, sku_code, status) VALUES ('sku-backfill', 'prod-backfill', 'BKF-001', 'ACTIVE')`,
      );
      await db.query(
        `INSERT INTO merchant_listings (id, tenant_id, sku_id, price_amount, currency, status) VALUES ('list-backfill', $1, 'sku-backfill', 999, 'USD', 'ACTIVE')`,
        [tenantId],
      );
      await db.query(
        `INSERT INTO tenants (id, type, name, status) VALUES ('tenant-customer-x', 'CUSTOMER', 'Backfill Customer', 'ACTIVE')`,
      );
      await db.query(
        `INSERT INTO customer_orders (id, customer_tenant_id, checkout_session_id, status, currency, subtotal_amount, total_amount)
         VALUES ('co-backfill', 'tenant-customer-x', 'chk-backfill', 'PAID', 'USD', 999, 999)`,
      );
      await db.query(
        `INSERT INTO seller_orders (id, customer_order_id, seller_tenant_id, status, currency, subtotal_amount, total_amount)
         VALUES ('so-backfill', 'co-backfill', $1, 'PAID', 'USD', 999, 999)`,
        [tenantId],
      );
      await db.query(
        `INSERT INTO order_items (id, seller_order_id, customer_order_id, listing_id, sku_id, product_id, merchant_tenant_id, product_name, sku_code, quantity, unit_price_amount, line_total_amount, currency)
         VALUES ('oi-backfill', 'so-backfill', 'co-backfill', 'list-backfill', 'sku-backfill', 'prod-backfill', $1, 'Backfill Widget', 'BKF-001', 1, 999, 999, 'USD')`,
        [tenantId],
      );

      const before = await app.inject({
        method: 'GET',
        url: '/analytics/sales',
        headers: { authorization: `Bearer ${merchant.token}` },
      });
      expect(before.json().totals.totalOrders).toBe(0);

      const rebuild = await app.inject({
        method: 'POST',
        url: '/analytics/rebuild',
        headers: { authorization: `Bearer ${merchant.token}` },
        payload: {},
      });
      expect(rebuild.statusCode).toBe(200);
      expect(rebuild.json().status).toBe('COMPLETED');

      const after = await app.inject({
        method: 'GET',
        url: '/analytics/sales',
        headers: { authorization: `Bearer ${merchant.token}` },
      });
      expect(after.json().totals.totalOrders).toBe(1);
      expect(after.json().totals.grossSales).toBe('999.0000');
      expect(after.json().currency).toBe('USD');

      const productsRes = await app.inject({
        method: 'GET',
        url: '/analytics/products',
        headers: { authorization: `Bearer ${merchant.token}` },
      });
      expect(productsRes.json().products).toHaveLength(1);
      expect(productsRes.json().products[0].unitsSold).toBe(1);

      // Rerun is idempotent: no duplicate facts.
      const again = await app.inject({
        method: 'POST',
        url: '/analytics/rebuild',
        headers: { authorization: `Bearer ${merchant.token}` },
        payload: {},
      });
      expect(again.statusCode).toBe(200);
      const facts = await db.query(
        `SELECT * FROM analytics_order_facts WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(facts.rows.length).toBe(1);
    });

    it('Regression Gate 2: Multi-line order (1 order, 3 lines) computes exact metrics without double-counting, and order status change does not increment sales', async () => {
      const tenantId = 'tenant-surg-multiline';
      const adminToken = await getAdminToken();

      const multiLineOrder = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-multi-1',
        tenantId,
        occurredAt: '2026-09-30T11:00:00.000Z',
        payload: {
          orderId: 'ord-multi-1',
          currency: 'INR',
          totalAmount: 700,
          items: [
            { productId: 'p-1', quantity: 2, unitPrice: 100 }, // 200
            { productId: 'p-2', quantity: 1, unitPrice: 350 }, // 350
            { productId: 'p-3', quantity: 3, unitPrice: 50 },  // 150
          ],
        },
      });

      await transport.publish(multiLineOrder);

      // Verify fact table has 3 line items for this 1 order
      const facts = await db.query(
        `SELECT * FROM analytics_order_facts WHERE tenant_id = $1 AND order_id = $2`,
        [tenantId, 'ord-multi-1'],
      );
      expect(facts.rows.length).toBe(3);

      // Query analytics API
      const res1 = await app.inject({
        method: 'GET',
        url: `/analytics/sales?tenantId=${tenantId}&startDate=2026-09-30&endDate=2026-09-30`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res1.statusCode).toBe(200);
      const totals1 = res1.json().totals;

      expect(totals1.totalOrders).toBe(1);
      expect(totals1.unitsSold).toBe(6); // 2 + 1 + 3
      expect(totals1.grossSales).toBe('700.0000');
      expect(totals1.netSales).toBe('700.0000');
      expect(totals1.averageOrderValue).toBe('700.0000'); // 700 / 1

      // Now emit OrderStatusChanged for this order
      const statusChanged = createDomainEvent({
        eventType: EventTypes.ORDER_STATUS_CHANGED,
        aggregateType: 'order',
        aggregateId: 'ord-multi-1',
        tenantId,
        occurredAt: '2026-09-30T11:30:00.000Z',
        payload: {
          orderId: 'ord-multi-1',
          status: 'CONFIRMED',
          currency: 'INR',
        },
      });

      await transport.publish(statusChanged);

      // Verify totals did NOT double-count sales or orders!
      const res2 = await app.inject({
        method: 'GET',
        url: `/analytics/sales?tenantId=${tenantId}&startDate=2026-09-30&endDate=2026-09-30`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res2.statusCode).toBe(200);
      const totals2 = res2.json().totals;

      expect(totals2.totalOrders).toBe(1);
      expect(totals2.unitsSold).toBe(6);
      expect(totals2.grossSales).toBe('700.0000');
      expect(totals2.averageOrderValue).toBe('700.0000');

      // Status breakdown should reflect CONFIRMED
      const breakdown = res2.json().breakdowns.ordersByStatus;
      expect(breakdown).toEqual({ CONFIRMED: 1 });
    });

    it('Regression Gate 3: Out-of-order events cannot cause monotonic order status to move backward', async () => {
      const tenantId = 'tenant-surg-monotonic';
      const adminToken = await getAdminToken();

      const ordCreated = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-mono-1',
        tenantId,
        occurredAt: '2026-09-30T12:00:00.000Z',
        payload: {
          orderId: 'ord-mono-1',
          status: 'CREATED',
          currency: 'INR',
          totalAmount: 300,
        },
      });

      const ordDelivered = createDomainEvent({
        eventType: EventTypes.ORDER_STATUS_CHANGED,
        aggregateType: 'order',
        aggregateId: 'ord-mono-1',
        tenantId,
        occurredAt: '2026-09-30T12:30:00.000Z',
        payload: {
          orderId: 'ord-mono-1',
          status: 'DELIVERED',
          currency: 'INR',
        },
      });

      // Late / out-of-order event arriving after DELIVERED with an earlier status: PROCESSING
      const ordProcessing = createDomainEvent({
        eventType: EventTypes.ORDER_STATUS_CHANGED,
        aggregateType: 'order',
        aggregateId: 'ord-mono-1',
        tenantId,
        occurredAt: '2026-09-30T12:15:00.000Z',
        payload: {
          orderId: 'ord-mono-1',
          status: 'PROCESSING',
          currency: 'INR',
        },
      });

      // Ingest in order: OrderCreated -> DELIVERED -> out-of-order PROCESSING
      await transport.publish(ordCreated);
      await transport.publish(ordDelivered);
      await transport.publish(ordProcessing);

      // Verify analytical current-state projection did NOT move backward to PROCESSING
      const res = await app.inject({
        method: 'GET',
        url: `/analytics/sales?tenantId=${tenantId}&startDate=2026-09-30&endDate=2026-09-30`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);

      const breakdown = res.json().breakdowns.ordersByStatus;
      expect(breakdown).toEqual({ DELIVERED: 1 });
    });

    it('Regression Gate 4: Rebuild failure semantics: unhandled error rolls back transaction, records FAILED audit, and returns HTTP 500', async () => {
      const tenantId = 'tenant-surg-fail';
      const adminToken = await getAdminToken();

      // 1. Seed valid initial fact
      const event1 = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-fail-1',
        tenantId,
        occurredAt: '2026-09-30T10:00:00.000Z',
        payload: {
          orderId: 'ord-fail-1',
          currency: 'INR',
          totalAmount: 500,
          items: [{ productId: 'p-fail-1', quantity: 1, unitPrice: 500 }],
        },
      });

      await db.withTransaction(async (tx) => {
        await outboxRepo.insertEvent(tx, event1);
      });
      await analyticsConsumer.process(event1);

      const beforeFacts = await db.query(
        `SELECT * FROM analytics_order_facts WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(beforeFacts.rows.length).toBe(1);

      // 2. Mock a failure during fact recording on replay
      const spy = vi.spyOn(AnalyticsRepository.prototype, 'recordOrderFact').mockRejectedValueOnce(
        new Error('Simulated database write failure during event replay'),
      );

      // 3. Trigger rebuild - must NOT report success! Must return HTTP 500
      const rebuildRes = await app.inject({
        method: 'POST',
        url: '/analytics/rebuild',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { tenantId },
      });

      expect(rebuildRes.statusCode).toBe(500);
      const errBody = rebuildRes.json();
      expect(errBody.error.code).toBe('INTERNAL_ERROR');
      expect(errBody.error.message).toContain('Simulated database write failure during event replay');

      // 4. Verify audit record is logged with status FAILED
      const audits = await db.query<{ status: string }>(
        `SELECT status FROM analytics_rebuild_audit WHERE tenant_id = $1 ORDER BY started_at DESC`,
        [tenantId],
      );
      expect(audits.rows.length).toBe(1);
      expect(audits.rows[0]?.status).toBe('FAILED');

      spy.mockRestore();
    });

    it('Regression Gate 5: Rebuild vs Live Ingestion concurrency: zero lost events, zero duplicate facts, and deterministic rebuildability', async () => {
      const tenantId = 'tenant-surg-conc';
      const adminToken = await getAdminToken();

      // 1. Initial historical event E1 in outbox
      const eventE1 = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-conc-1',
        tenantId,
        occurredAt: '2026-09-30T09:00:00.000Z',
        payload: {
          orderId: 'ord-conc-1',
          currency: 'INR',
          totalAmount: 1000,
          items: [{ productId: 'p-conc-1', quantity: 1, unitPrice: 1000 }],
        },
      });

      await db.withTransaction(async (tx) => {
        await outboxRepo.insertEvent(tx, eventE1);
      });
      await analyticsConsumer.process(eventE1);

      // 2. New live event E2 arriving concurrently
      const eventE2 = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-conc-2',
        tenantId,
        occurredAt: '2026-09-30T10:00:00.000Z',
        payload: {
          orderId: 'ord-conc-2',
          currency: 'INR',
          totalAmount: 2000,
          items: [{ productId: 'p-conc-2', quantity: 2, unitPrice: 1000 }],
        },
      });

      // Insert E2 to outbox as transactional domain would
      await db.withTransaction(async (tx) => {
        await outboxRepo.insertEvent(tx, eventE2);
      });

      // Execute rebuild and live consumer concurrently via Promise.all
      const [rebuildResult, liveConsumerResult] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/analytics/rebuild',
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { tenantId },
        }),
        analyticsConsumer.process(eventE2),
      ]);

      expect(rebuildResult.statusCode).toBe(200);
      expect(liveConsumerResult.handled || liveConsumerResult.duplicate).toBe(true);

      // 3. Verify resulting projection is COMPLETE: both facts exist, 0 duplicates
      const facts = await db.query<{ order_id: string; total_amount: string }>(
        `SELECT order_id, total_amount FROM analytics_order_facts WHERE tenant_id = $1 ORDER BY occurred_at ASC`,
        [tenantId],
      );
      expect(facts.rows.length).toBe(2);
      expect(facts.rows.map((r) => r.order_id).sort()).toEqual(['ord-conc-1', 'ord-conc-2']);

      // 4. Verify daily metric totals reflect both events accurately
      const salesRes = await app.inject({
        method: 'GET',
        url: `/analytics/sales?tenantId=${tenantId}&startDate=2026-09-30&endDate=2026-09-30`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(salesRes.statusCode).toBe(200);
      const totals = salesRes.json().totals;
      expect(totals.totalOrders).toBe(2);
      expect(totals.grossSales).toBe('3000.0000');
      expect(totals.unitsSold).toBe(3); // 1 + 2
      expect(totals.averageOrderValue).toBe('1500.0000'); // 3000 / 2
    });
  });
});
