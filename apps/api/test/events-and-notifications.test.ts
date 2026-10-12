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
import { InMemorySearchStore } from '../src/modules/search/index.js';
import {
  createDomainEvent,
  EventTypes,
  InMemoryEventTransport,
  OutboxRepository,
  OutboxService,
  BaseEventConsumer,
} from '../src/modules/events/index.js';
import {
  NotificationService,
  NotificationRepository,
  InMemoryEmailProvider,
  InMemorySmsProvider,
  InMemoryPushProvider,
} from '../src/modules/notifications/index.js';
import { JsonLogger } from '../src/observability/logger.js';

const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

describe('Phase 10: Events & Notifications Architecture', () => {
  let app: FastifyInstance;
  let db: DatabaseConnection;
  let searchStore: InMemorySearchStore;
  let transport: InMemoryEventTransport;
  let emailProvider: InMemoryEmailProvider;
  let smsProvider: InMemorySmsProvider;
  let pushProvider: InMemoryPushProvider;
  let outboxService: OutboxService;
  let outboxRepo: OutboxRepository;
  let notificationService: NotificationService;
  let notificationRepo: NotificationRepository;
  let logger: JsonLogger;

  beforeEach(async () => {
    db = await createMigratedTestDatabase();
    searchStore = new InMemorySearchStore();
    transport = new InMemoryEventTransport();
    emailProvider = new InMemoryEmailProvider();
    smsProvider = new InMemorySmsProvider();
    pushProvider = new InMemoryPushProvider();
    logger = new JsonLogger({ serviceName: 'test-events', level: 'info' });

    outboxRepo = new OutboxRepository();
    outboxService = new OutboxService(db, outboxRepo, transport, logger);

    notificationRepo = new NotificationRepository();
    notificationService = new NotificationService(
      db,
      notificationRepo,
      emailProvider,
      smsProvider,
      pushProvider,
      logger,
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

  async function getCustomerToken(email = 'customer@buyer.com') {
    return registerVerifiedUser(app, db, {
      email,
      password: 'Password123!',
      tenantName: 'Customer Tenant',
      role: 'CUSTOMER',
    });
  }

  // --- OUTBOX FAILURE MATRIX (SCENARIOS A - I) ---

  describe('Transactional Outbox Atomicity & Lifecycle (Scenarios A - I)', () => {
    it('Scenario A: business mutation + outbox event commit atomically together in single transaction', async () => {
      const event = createDomainEvent({
        eventType: EventTypes.CATALOG_PRODUCT_CREATED,
        aggregateType: 'product',
        aggregateId: 'p-100',
        tenantId: 'tenant-platform',
        payload: { title: 'Test Smartphone', price: 50000 },
        metadata: { correlationId: 'corr-1' },
      });

      // Execute business state mutation and outbox event inside same transaction
      await db.withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO tenants (id, type, name, status) VALUES ('tenant-platform', 'PLATFORM', 'Main Platform', 'ACTIVE')`,
        );
        await outboxService.recordEvent(tx, event);
      });

      // Verify both tenant and outbox event exist in DB
      const tenantRes = await db.query(`SELECT * FROM tenants WHERE id = 'tenant-platform'`);
      expect(tenantRes.rows.length).toBe(1);

      const outboxRes = await outboxRepo.getEventById(db, event.eventId);
      expect(outboxRes).not.toBeNull();
      expect(outboxRes?.status).toBe('PENDING');
      expect(outboxRes?.aggregateId).toBe('p-100');
      expect(outboxRes?.payload.title).toBe('Test Smartphone');
    });

    it('Scenario B: business mutation failure rolls back outbox event (no orphan event)', async () => {
      const event = createDomainEvent({
        eventType: EventTypes.CATALOG_PRODUCT_CREATED,
        aggregateType: 'product',
        aggregateId: 'p-fail-1',
        tenantId: 'tenant-fail',
        payload: { title: 'Failing Product' },
      });

      // The in-memory database now runs each transaction on a dedicated
      // client with native rollback, so no manual compensation is needed:
      // assert the behavioral contract (abort propagates, writes revert).
      // Transaction throws an error after outbox write
      await expect(
        db.withTransaction(async (tx) => {
          await outboxService.recordEvent(tx, event);
          throw new Error('Database transaction abort simulated');
        }),
      ).rejects.toThrow('Database transaction abort simulated');

      // Verify outbox record was rolled back
      const outboxRes = await outboxRepo.getEventById(db, event.eventId);
      expect(outboxRes).toBeNull();
    });

    it('Scenario C: outbox insert failure rolls back business mutation (no event loss window)', async () => {
      const event = createDomainEvent({
        eventId: 'evt-dup-id',
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-100',
        tenantId: 'tenant-c',
        payload: { total: 100 },
      });

      // Pre-insert event to trigger duplicate primary key collision on second insert
      await db.withTransaction(async (tx) => {
        await outboxService.recordEvent(tx, event);
      });

      // New transaction attempts business mutation + duplicate event insert
      await expect(
        db.withTransaction(async (tx) => {
          await tx.query(
            `INSERT INTO tenants (id, type, name, status) VALUES ('tenant-c-biz', 'CUSTOMER', 'Cust Biz', 'ACTIVE')`,
          );
          // Duplicate event insert must fail
          await outboxService.recordEvent(tx, event);
        }),
      ).rejects.toThrow();

      // Verify business mutation was safely rolled back
      const bizRes = await db.query(`SELECT * FROM tenants WHERE id = 'tenant-c-biz'`);
      expect(bizRes.rows.length).toBe(0);
    });

    it('Scenario D: publisher crash before publish leaves event safely in PENDING status', async () => {
      const event = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-crash-1',
        tenantId: 'tenant-d',
        payload: { total: 200 },
      });

      await db.withTransaction(async (tx) => {
        await outboxService.recordEvent(tx, event);
      });

      // Event is stored as PENDING and un-dispatched
      const before = await outboxRepo.getEventById(db, event.eventId);
      expect(before?.status).toBe('PENDING');
      expect(transport.getPublishedEvents().length).toBe(0);
    });

    it('Scenario E: publisher crash after external transport publish does not cause data loss; reclaims safely', async () => {
      const event = createDomainEvent({
        eventType: EventTypes.PAYMENT_SUCCEEDED,
        aggregateType: 'payment_intent',
        aggregateId: 'pi-crash-2',
        tenantId: 'tenant-e',
        payload: { amount: 1500, currency: 'USD' },
      });

      await db.withTransaction(async (tx) => {
        await outboxService.recordEvent(tx, event);
      });

      // Claim event with a short lease (10ms)
      const claimed = await outboxRepo.claimBatch(db, 10, 10);
      expect(claimed.length).toBe(1);
      expect(claimed[0]!.status).toBe('PROCESSING');

      // Publish to transport but simulate crash before markPublished is recorded
      await transport.publish(event);
      expect(transport.getPublishedEvents().length).toBe(1);

      // Wait for lease to expire
      await new Promise((res) => setTimeout(res, 20));

      // Second worker claims expired-lease event and safely re-publishes
      const result = await outboxService.publishPendingEvents({ leaseDurationMs: 5000 });
      expect(result.publishedCount).toBe(1);

      const after = await outboxRepo.getEventById(db, event.eventId);
      expect(after?.status).toBe('PUBLISHED');
    });

    it('Scenario F: processing lease expiration allows another worker to reclaim stranded event', async () => {
      const event = createDomainEvent({
        eventType: EventTypes.ORDER_STATUS_CHANGED,
        aggregateType: 'order',
        aggregateId: 'ord-lease-1',
        tenantId: 'tenant-f',
        payload: { status: 'CONFIRMED' },
      });

      await db.withTransaction(async (tx) => {
        await outboxService.recordEvent(tx, event);
      });

      // Claim with 15ms lease
      const claimed = await outboxRepo.claimBatch(db, 10, 15);
      expect(claimed.length).toBe(1);
      expect(claimed[0]!.status).toBe('PROCESSING');

      // Expire lease
      await new Promise((res) => setTimeout(res, 30));

      // Worker 2 should reclaim the stranded event
      const reclaimed = await outboxRepo.claimBatch(db, 10, 5000);
      expect(reclaimed.length).toBe(1);
      expect(reclaimed[0]!.eventId).toBe(event.eventId);
      expect(reclaimed[0]!.attemptCount).toBe(2);
    });

    it('Scenario G: concurrent publisher workers do not duplicate claims on the same outbox records', async () => {
      // Seed 5 outbox events
      for (let i = 1; i <= 5; i++) {
        const evt = createDomainEvent({
          eventType: EventTypes.ORDER_CREATED,
          aggregateType: 'order',
          aggregateId: `ord-conc-${i}`,
          tenantId: 'tenant-g',
          payload: { orderNumber: i },
        });
        await db.withTransaction(async (tx) => {
          await outboxService.recordEvent(tx, evt);
        });
      }

      // Dispatch 3 concurrent publisher workers
      const [w1, w2, w3] = await Promise.all([
        outboxService.publishPendingEvents({ batchSize: 3 }),
        outboxService.publishPendingEvents({ batchSize: 3 }),
        outboxService.publishPendingEvents({ batchSize: 3 }),
      ]);

      // Verify that concurrent workers did not duplicate claims on the same records
      // (sum of claims does not exceed batchSize of claimed records)
      let totalPublished = w1.publishedCount + w2.publishedCount + w3.publishedCount;
      expect(totalPublished).toBeLessThanOrEqual(5);

      // Drain remaining pending records with another concurrent sweep
      if (totalPublished < 5) {
        const [w4, w5] = await Promise.all([
          outboxService.publishPendingEvents({ batchSize: 3 }),
          outboxService.publishPendingEvents({ batchSize: 3 }),
        ]);
        totalPublished += w4.publishedCount + w5.publishedCount;
      }

      expect(totalPublished).toBe(5);

      // Verify all 5 events are marked PUBLISHED exactly once
      const list = await outboxRepo.listEvents(db, { status: 'PUBLISHED' });
      expect(list.total).toBe(5);
    });

    it('Scenario H: outbox retry after transport failure with exponential backoff', async () => {
      const event = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-retry-1',
        tenantId: 'tenant-h',
        payload: { total: 300 },
      });

      await db.withTransaction(async (tx) => {
        await outboxService.recordEvent(tx, event);
      });

      // Simulate transport failure
      transport.setSimulateFailure(true);

      const res1 = await outboxService.publishPendingEvents({
        maxAttempts: 3,
        baseRetryDelayMs: 20,
      });
      expect(res1.failedCount).toBe(1);

      const afterFail = await outboxRepo.getEventById(db, event.eventId);
      expect(afterFail?.status).toBe('PENDING');
      expect(afterFail?.attemptCount).toBe(1);
      expect(afterFail?.lastError).toContain('simulated outage');

      // Restore transport and wait for retry delay
      transport.setSimulateFailure(false);
      await new Promise((res) => setTimeout(res, 30));

      const res2 = await outboxService.publishPendingEvents();
      expect(res2.publishedCount).toBe(1);

      const afterSuccess = await outboxRepo.getEventById(db, event.eventId);
      expect(afterSuccess?.status).toBe('PUBLISHED');
    });

    it('Scenario I: event exceeding maximum attempts is permanently quarantined to DEAD_LETTERED', async () => {
      const event = createDomainEvent({
        eventType: EventTypes.PAYMENT_FAILED,
        aggregateType: 'payment_intent',
        aggregateId: 'pi-dlq-1',
        tenantId: 'tenant-i',
        payload: { reason: 'card_declined' },
      });

      await db.withTransaction(async (tx) => {
        await outboxService.recordEvent(tx, event);
      });

      transport.setSimulateFailure(true);

      // Attempt 1 -> fails, retry scheduled
      await outboxService.publishPendingEvents({ maxAttempts: 2, baseRetryDelayMs: 10 });
      await new Promise((res) => setTimeout(res, 15));

      // Attempt 2 (reaches maxAttempts = 2) -> DEAD_LETTERED
      const res2 = await outboxService.publishPendingEvents({
        maxAttempts: 2,
        baseRetryDelayMs: 10,
      });
      expect(res2.deadLetteredCount).toBe(1);

      const dlqDoc = await outboxRepo.getEventById(db, event.eventId);
      expect(dlqDoc?.status).toBe('DEAD_LETTERED');
      expect(dlqDoc?.attemptCount).toBe(2);

      // Administrative replay resets status to PENDING
      const adminToken = await getAdminToken();
      const replayRes = await app.inject({
        method: 'POST',
        url: `/events/outbox/${event.eventId}/replay`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(replayRes.statusCode).toBe(200);

      const replayedDoc = await outboxRepo.getEventById(db, event.eventId);
      expect(replayedDoc?.status).toBe('PENDING');
      expect(replayedDoc?.attemptCount).toBe(0);
    });
  });

  // --- CONSUMER IDEMPOTENCY MATRIX (SCENARIOS J - N) ---

  describe('Consumer Idempotency & Fault Tolerance (Scenarios J - N)', () => {
    it('Scenario J: same event delivered twice produces zero duplicate side effects', async () => {
      let sideEffectCount = 0;

      class TestConsumer extends BaseEventConsumer {
        constructor() {
          super('test-counter-consumer', db, outboxRepo, transport, logger);
        }
        registerSubscriptions() {}
        protected async handleEvent(): Promise<void> {
          sideEffectCount += 1;
        }
      }

      const consumer = new TestConsumer();
      const event = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-j-1',
        tenantId: 'tenant-j',
        payload: {},
      });

      // First delivery: executed
      const r1 = await consumer.process(event);
      expect(r1.handled).toBe(true);
      expect(r1.duplicate).toBe(false);
      expect(sideEffectCount).toBe(1);

      // Second delivery: recognized as duplicate via consumer receipt
      const r2 = await consumer.process(event);
      expect(r2.handled).toBe(false);
      expect(r2.duplicate).toBe(true);
      expect(sideEffectCount).toBe(1); // Crucial invariant: zero duplicate side effect!
    });

    it('Scenario K: concurrent delivery of identical event is safely deduplicated via UNIQUE constraint', async () => {
      let sideEffectCount = 0;

      class TestConcurrentConsumer extends BaseEventConsumer {
        constructor() {
          super('concurrent-consumer', db, outboxRepo, transport, logger);
        }
        registerSubscriptions() {}
        protected async handleEvent(): Promise<void> {
          sideEffectCount += 1;
        }
      }

      const consumer = new TestConcurrentConsumer();
      const event = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-k-1',
        tenantId: 'tenant-k',
        payload: {},
      });

      // Dispatch 3 concurrent executions of the exact same event
      const [r1, r2, r3] = await Promise.all([
        consumer.process(event),
        consumer.process(event),
        consumer.process(event),
      ]);

      const handledCount = [r1, r2, r3].filter((r) => r.handled).length;
      expect(handledCount).toBe(1);
      expect(sideEffectCount).toBe(1);
    });

    it('Scenario M: unsupported event version is quarantined without corrupting state', async () => {
      let executed = false;

      class TestVersionConsumer extends BaseEventConsumer {
        constructor() {
          super('version-consumer', db, outboxRepo, transport, logger);
        }
        registerSubscriptions() {}
        protected async handleEvent(): Promise<void> {
          executed = true;
        }
      }

      const consumer = new TestVersionConsumer();
      const event = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        eventVersion: 99, // Unsupported future schema version!
        aggregateType: 'order',
        aggregateId: 'ord-m-1',
        tenantId: 'tenant-m',
        payload: {},
      });

      const res = await consumer.process(event);
      expect(res.handled).toBe(false);
      expect(res.quarantined).toBe(true);
      expect(executed).toBe(false);

      const receipt = await outboxRepo.findReceipt(db, 'version-consumer', event.eventId);
      expect(receipt?.status).toBe('QUARANTINED');
    });
  });

  // --- NOTIFICATION DOMAIN & IDEMPOTENCY (SCENARIOS O - T) ---

  describe('Notification Domain, Channels & Preferences (Scenarios O - T)', () => {
    it('Scenario O & P: notification provider failure schedules retry, and recovery sends successfully', async () => {
      emailProvider.setSimulateFailure(true);

      const req = await notificationService.requestNotification({
        tenantId: 'tenant-op',
        eventId: 'evt-op-1',
        notificationType: 'ORDER_CONFIRMATION',
        channel: 'EMAIL',
        recipient: 'buyer@store.com',
        templateId: 'tpl_order',
        payload: { subject: 'Order Confirmed', body: 'Your order was received.' },
      });
      expect(req.status).toBe('PENDING');

      // Worker run 1 fails
      const p1 = await notificationService.processPendingNotifications({ baseRetryDelayMs: 15 });
      expect(p1.failed).toBe(1);

      const notifDoc = await notificationRepo.getNotificationById(db, req.notificationId);
      expect(notifDoc?.status).toBe('RETRY_SCHEDULED');
      expect(notifDoc?.lastError).toContain('SMTP connection timed out');

      // Restore email provider and wait for retry delay
      emailProvider.setSimulateFailure(false);
      await new Promise((res) => setTimeout(res, 25));

      // Worker run 2 succeeds
      const p2 = await notificationService.processPendingNotifications();
      expect(p2.sent).toBe(1);

      const sentDoc = await notificationRepo.getNotificationById(db, req.notificationId);
      expect(sentDoc?.status).toBe('SENT');
      expect(emailProvider.getSentEmails().length).toBe(1);
    });

    it('Scenario Q: duplicate notification request returns existing record without duplicate dispatch', async () => {
      const input = {
        tenantId: 'tenant-q',
        eventId: 'evt-q-1',
        notificationType: 'PAYMENT_RECEIPT' as const,
        channel: 'EMAIL' as const,
        recipient: 'user@bank.com',
        templateId: 'tpl_receipt',
        payload: { subject: 'Receipt', body: 'Paid $50' },
      };

      const res1 = await notificationService.requestNotification(input);
      expect(res1.status).toBe('PENDING');

      // Duplicate request with exact same event, type, recipient, and channel
      const res2 = await notificationService.requestNotification(input);
      expect(res2.notificationId).toBe(res1.notificationId);

      // Process notifications
      await notificationService.processPendingNotifications();
      expect(emailProvider.getSentEmails().length).toBe(1); // Exactly 1 email sent!
    });

    it('Scenario S: customer preference disables email/SMS notification cleanly', async () => {
      // Set customer preference: disable EMAIL
      await notificationService.setCustomerPreferences('tenant-s', 'cust-s-1', {
        emailEnabled: false,
        smsEnabled: true,
      });

      const res = await notificationService.requestNotification({
        tenantId: 'tenant-s',
        customerId: 'cust-s-1',
        eventId: 'evt-s-1',
        notificationType: 'ORDER_CONFIRMATION',
        channel: 'EMAIL',
        recipient: 'optout@buyer.com',
        templateId: 'tpl_order',
        payload: { subject: 'Order', body: 'Details' },
      });

      expect(res.skipped).toBe(true);
      expect(res.reason).toBe('CUSTOMER_EMAIL_DISABLED');
      expect(emailProvider.getSentEmails().length).toBe(0);
    });

    it('Scenario T: cross-tenant notification preference isolation is strictly preserved', async () => {
      // Customer in Tenant A disables SMS
      await notificationService.setCustomerPreferences('tenant-alpha', 'shared-user-id', {
        smsEnabled: false,
      });

      // Customer in Tenant B keeps SMS enabled
      await notificationService.setCustomerPreferences('tenant-beta', 'shared-user-id', {
        smsEnabled: true,
      });

      const prefA = await notificationService.getCustomerPreferences(
        'tenant-alpha',
        'shared-user-id',
      );
      const prefB = await notificationService.getCustomerPreferences(
        'tenant-beta',
        'shared-user-id',
      );

      expect(prefA?.smsEnabled).toBe(false);
      expect(prefB?.smsEnabled).toBe(true);
    });
  });

  // --- SEARCH EVENT INTEGRATION (SCENARIOS U - Y) ---

  describe('Search Event Consumer Integration (Scenarios U - Y)', () => {
    it('Scenario U & V: Catalog Product and Marketplace Listing events project into SearchStore', async () => {
      // 1. Dispatch Product Created Event
      const prodEvent = createDomainEvent({
        eventType: EventTypes.CATALOG_PRODUCT_CREATED,
        aggregateType: 'product',
        aggregateId: 'prod-evt-1',
        tenantId: 'tenant-platform',
        payload: {
          productId: 'prod-evt-1',
          title: 'Flagship Smartphone X',
          slug: 'smartphone-x',
          status: 'ACTIVE',
          sourceVersion: 10,
        },
      });

      await transport.publish(prodEvent);

      const docBeforeOffer = await searchStore.getDocument('prod-evt-1');
      expect(docBeforeOffer).not.toBeNull();
      expect(docBeforeOffer?.title).toBe('Flagship Smartphone X');

      // 2. Dispatch Listing Created Event
      const listEvent = createDomainEvent({
        eventType: EventTypes.MARKETPLACE_LISTING_CREATED,
        aggregateType: 'listing',
        aggregateId: 'list-evt-1',
        tenantId: 'merchant-alpha',
        payload: {
          listingId: 'list-evt-1',
          merchantId: 'merchant-alpha',
          productId: 'prod-evt-1',
          skuId: 'sku-evt-1',
          skuCode: 'SKU-X-1',
          priceAmount: 89900,
          currency: 'USD',
          status: 'ACTIVE',
          inStock: true,
          availableQuantity: 15,
          sourceVersion: 10,
        },
      });

      await transport.publish(listEvent);

      const docWithOffer = await searchStore.getDocument('prod-evt-1');
      expect(docWithOffer?.offers.length).toBe(1);
      expect(docWithOffer?.offers[0]!.priceAmount).toBe(89900);
      expect(docWithOffer?.offers[0]!.merchantId).toBe('merchant-alpha');
    });

    it('Scenario W: duplicate search event delivery is ignored without duplicate projection increments', async () => {
      const prodEvent = createDomainEvent({
        eventType: EventTypes.CATALOG_PRODUCT_CREATED,
        aggregateType: 'product',
        aggregateId: 'prod-w-1',
        tenantId: 'tenant-w',
        payload: {
          productId: 'prod-w-1',
          title: 'Deduplicated Product',
          slug: 'dedup-prod',
          status: 'ACTIVE',
          sourceVersion: 1,
        },
      });

      await transport.publish(prodEvent);
      const doc1 = await searchStore.getDocument('prod-w-1');
      const projectionVersion1 = doc1?.projectionVersion;

      // Re-publish exact same event (simulating at-least-once transport replay)
      await transport.publish(prodEvent);

      const doc2 = await searchStore.getDocument('prod-w-1');
      expect(doc2?.projectionVersion).toBe(projectionVersion1);
    });

    it('Scenario X: out-of-order search event with older sourceVersion is rejected', async () => {
      // Version 20 arrives first
      const v20Event = createDomainEvent({
        eventType: EventTypes.CATALOG_PRODUCT_UPDATED,
        aggregateType: 'product',
        aggregateId: 'prod-x-1',
        tenantId: 'tenant-x',
        payload: {
          productId: 'prod-x-1',
          title: 'Newest Version 20 Title',
          slug: 'prod-x',
          status: 'ACTIVE',
          sourceVersion: 20,
        },
      });
      await transport.publish(v20Event);

      // Stale Version 10 arrives second (out of order)
      const v10Event = createDomainEvent({
        eventType: EventTypes.CATALOG_PRODUCT_UPDATED,
        aggregateType: 'product',
        aggregateId: 'prod-x-1',
        tenantId: 'tenant-x',
        payload: {
          productId: 'prod-x-1',
          title: 'Stale Version 10 Title',
          slug: 'prod-x',
          status: 'ACTIVE',
          sourceVersion: 10,
        },
      });
      await transport.publish(v10Event);

      // Title must remain Version 20 title
      const doc = await searchStore.getDocument('prod-x-1');
      expect(doc?.title).toBe('Newest Version 20 Title');
      expect(doc?.sourceVersion).toBe(20);
    });

    it('Scenario Y: search consumer failure records FAILED receipt and recovers cleanly on retry', async () => {
      searchStore.setAvailability(false);

      const event = createDomainEvent({
        eventType: EventTypes.CATALOG_PRODUCT_CREATED,
        aggregateType: 'product',
        aggregateId: 'prod-y-1',
        tenantId: 'tenant-y',
        payload: {
          productId: 'prod-y-1',
          title: 'Store Down Product',
          slug: 'store-down',
          status: 'ACTIVE',
          sourceVersion: 1,
        },
      });

      await transport.publish(event);

      const receiptFailed = await outboxRepo.findReceipt(db, 'search-projector', event.eventId);
      expect(receiptFailed?.status).toBe('FAILED');

      // Restore search store availability
      searchStore.setAvailability(true);

      // Clean receipt to simulate background retry
      await db.query(`DELETE FROM event_consumer_receipts WHERE event_id = $1`, [event.eventId]);
      await transport.publish(event);

      const receiptSuccess = await outboxRepo.findReceipt(db, 'search-projector', event.eventId);
      expect(receiptSuccess?.status).toBe('COMPLETED');

      const doc = await searchStore.getDocument('prod-y-1');
      expect(doc?.title).toBe('Store Down Product');
    });
  });

  // --- SECURITY, RBAC & ADMINISTRATIVE API ---

  describe('Security, RBAC & Administrative Controls', () => {
    it('prevents sensitive tokens and passwords in event payloads', () => {
      expect(() => {
        createDomainEvent({
          eventType: EventTypes.ORDER_CREATED,
          aggregateType: 'order',
          aggregateId: 'ord-sec-1',
          tenantId: 'tenant-sec',
          payload: {
            orderId: 'ord-sec-1',
            password: 'plaintext-secret-123',
          },
        });
      }).toThrow('Security violation: Prohibited sensitive key');

      expect(() => {
        createDomainEvent({
          eventType: EventTypes.PAYMENT_SUCCEEDED,
          aggregateType: 'payment_intent',
          aggregateId: 'pi-sec-1',
          tenantId: 'tenant-sec',
          payload: {
            cardNumber: '4111111111111111',
          },
        });
      }).toThrow('Security violation: Prohibited sensitive key');
    });

    it('rejects non-administrators from inspecting outbox or retrying notifications', async () => {
      const custToken = await getCustomerToken('buyer-rbac@store.com');

      const outboxRes = await app.inject({
        method: 'GET',
        url: '/events/outbox',
        headers: { authorization: `Bearer ${custToken}` },
      });
      expect(outboxRes.statusCode).toBe(403);

      const notifRes = await app.inject({
        method: 'GET',
        url: '/notifications',
        headers: { authorization: `Bearer ${custToken}` },
      });
      expect(notifRes.statusCode).toBe(403);

      const replayRes = await app.inject({
        method: 'POST',
        url: '/events/outbox/some-id/replay',
        headers: { authorization: `Bearer ${custToken}` },
      });
      expect(replayRes.statusCode).toBe(403);
    });

    it('allows administrators to list outbox events and view details via HTTP API', async () => {
      const adminToken = await getAdminToken();

      const event = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-admin-1',
        tenantId: 'tenant-admin',
        payload: { amount: 500 },
      });

      await db.withTransaction(async (tx) => {
        await outboxService.recordEvent(tx, event);
      });

      const listRes = await app.inject({
        method: 'GET',
        url: '/events/outbox?status=PENDING',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().total).toBeGreaterThanOrEqual(1);

      const detailRes = await app.inject({
        method: 'GET',
        url: `/events/outbox/${event.eventId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(detailRes.statusCode).toBe(200);
      expect(detailRes.json().aggregateId).toBe('ord-admin-1');
    });
  });
});
