import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { createTestDatabase } from './helpers/test-db.js';
import { DatabaseConnection } from '../src/infra/database/connection.js';
import { buildApp } from '../src/app.js';
import { NotificationsConfig } from '../src/config/index.js';
import {
  InMemoryEmailProvider,
  InMemorySmsProvider,
  InMemoryPushProvider,
} from '../src/channels/in-memory-providers.js';
import { NotificationRepository } from '../src/repository/notification-repository.js';
import { NotificationService } from '../src/domain/notification-service.js';
import { NotificationEventConsumer } from '../src/events/notification-event-consumer.js';
import { DomainEvent } from '../src/events/event-models.js';

describe('HTTP API Endpoints', () => {
  let db: DatabaseConnection;
  let app: FastifyInstance;
  const jwtSecret = 'test-secret-key-12345';

  const testConfig: NotificationsConfig = {
    app: {
      port: 3004,
      host: '0.0.0.0',
      nodeEnv: 'test',
      logLevel: 'info',
    },
    database: {
      url: 'postgres://mem:mem@localhost:5432/mem',
      host: 'localhost',
      port: 5432,
      name: 'mem',
      user: 'mem',
      password: 'mem',
      poolMin: 1,
      poolMax: 10,
    },
    auth: {
      jwtSecret,
      internalServiceKey: 'test-internal-service-key-12345',
    },
    channels: {
      emailFrom: 'noreply@ecommerce.test',
    },
    processing: {
      batchSize: 50,
      baseRetryDelayMs: 1000,
      maxAttempts: 3,
      consumerReceiptStaleTimeoutMs: 300000,
    },
  };

  const internalKey = 'test-internal-service-key-12345';

  function createToken(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const fullPayload = {
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...payload,
    };
    const body = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
    const sig = createHash('sha256').update(`${header}.${body}.${jwtSecret}`).digest('base64url');
    return `${header}.${body}.${sig}`;
  }

  const adminToken = createToken({ sub: 'admin-1', tid: 'ten-1', rol: 'ADMINISTRATOR' });
  const customerToken = createToken({ sub: 'cust-1', tid: 'ten-1', rol: 'CUSTOMER' });

  beforeEach(async () => {
    db = await createTestDatabase();
    app = buildApp({
      config: testConfig,
      db,
      emailProvider: new InMemoryEmailProvider(),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await db.end();
  });

  describe('Health & Readiness', () => {
    it('GET /health returns 200 ok', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.status).toBe('ok');
      expect(json.service).toBe('notifications-service');
    });

    it('GET /ready returns 200 ready when db connected', async () => {
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.status).toBe('ready');
      expect(json.database).toBe('connected');
    });
  });

  describe('Internal APIs', () => {
    it('rejects unauthenticated requests to internal endpoints', async () => {
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/internal/notifications/request',
        payload: {
          tenantId: 'ten-1',
          notificationType: 'ORDER_CONFIRMATION',
          channel: 'EMAIL',
          recipient: 'buyer@test.com',
          payload: { orderId: 'ord-123' },
        },
      });
      expect(res1.statusCode).toBe(401);

      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/internal/notifications/transactional-email',
        payload: {
          recipient: 'welcome@test.com',
          subject: 'Welcome',
          body: 'Thanks',
        },
      });
      expect(res2.statusCode).toBe(401);
    });

    it('rejects invalid or incorrectly signed credentials', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/notifications/request',
        headers: { 'x-internal-service-key': 'wrong-internal-service-key' },
        payload: {
          tenantId: 'ten-1',
          notificationType: 'ORDER_CONFIRMATION',
          channel: 'EMAIL',
          recipient: 'buyer@test.com',
          payload: { orderId: 'ord-123' },
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('POST /v1/internal/notifications/request creates a notification when authorized', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/notifications/request',
        headers: { 'x-internal-service-key': internalKey },
        payload: {
          tenantId: 'ten-1',
          eventId: 'evt-req-1',
          notificationType: 'ORDER_CONFIRMATION',
          channel: 'EMAIL',
          recipient: 'buyer@test.com',
          payload: { orderId: 'ord-123' },
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.notificationId).toBeDefined();
      expect(json.status).toBe('PENDING');
      expect(json.recipient).toBe('buyer@test.com');
    });

    it('POST /v1/internal/notifications/request rejects missing, empty, and whitespace-only eventId', async () => {
      // 1. Missing eventId
      const resMissing = await app.inject({
        method: 'POST',
        url: '/v1/internal/notifications/request',
        headers: { 'x-internal-service-key': internalKey },
        payload: {
          tenantId: 'ten-1',
          notificationType: 'ORDER_CONFIRMATION',
          channel: 'EMAIL',
          recipient: 'buyer@test.com',
          payload: { orderId: 'ord-123' },
        },
      });
      expect(resMissing.statusCode).toBe(400);
      expect(resMissing.json().error.code).toBe('VALIDATION_FAILED');
      expect(resMissing.json().error.message).toContain(
        'eventId is required and must be a non-empty string',
      );

      // 2. Empty string eventId
      const resEmpty = await app.inject({
        method: 'POST',
        url: '/v1/internal/notifications/request',
        headers: { 'x-internal-service-key': internalKey },
        payload: {
          tenantId: 'ten-1',
          eventId: '',
          notificationType: 'ORDER_CONFIRMATION',
          channel: 'EMAIL',
          recipient: 'buyer@test.com',
          payload: { orderId: 'ord-123' },
        },
      });
      expect(resEmpty.statusCode).toBe(400);
      expect(resEmpty.json().error.code).toBe('VALIDATION_FAILED');
      expect(resEmpty.json().error.message).toContain(
        'eventId is required and must be a non-empty string',
      );

      // 3. Whitespace-only eventId
      const resWhitespace = await app.inject({
        method: 'POST',
        url: '/v1/internal/notifications/request',
        headers: { 'x-internal-service-key': internalKey },
        payload: {
          tenantId: 'ten-1',
          eventId: '   ',
          notificationType: 'ORDER_CONFIRMATION',
          channel: 'EMAIL',
          recipient: 'buyer@test.com',
          payload: { orderId: 'ord-123' },
        },
      });
      expect(resWhitespace.statusCode).toBe(400);
      expect(resWhitespace.json().error.code).toBe('VALIDATION_FAILED');
      expect(resWhitespace.json().error.message).toContain(
        'eventId is required and must be a non-empty string',
      );
    });

    it('POST /v1/internal/notifications/request also accepts Authorization Bearer with internal key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/notifications/request',
        headers: { authorization: `Bearer ${internalKey}` },
        payload: {
          tenantId: 'ten-1',
          eventId: 'evt-bearer-1',
          notificationType: 'ORDER_CONFIRMATION',
          channel: 'EMAIL',
          recipient: 'bearer@test.com',
          payload: { orderId: 'ord-456' },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().recipient).toBe('bearer@test.com');
    });

    it('POST /v1/internal/notifications/transactional-email executes synchronously and returns providerMessageId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/notifications/transactional-email',
        headers: { 'x-internal-service-key': internalKey },
        payload: {
          recipient: 'welcome@test.com',
          subject: 'Welcome to our platform',
          body: 'Thanks for signing up!',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.providerMessageId).toBeDefined();
      expect(typeof json.providerMessageId).toBe('string');
    });

    it('POST /v1/internal/notifications/transactional-email validates required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/notifications/transactional-email',
        headers: { 'x-internal-service-key': internalKey },
        payload: {
          recipient: '',
          subject: 'Subject',
          body: 'Body',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /v1/internal/notifications/process rejects unauthenticated requests', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/notifications/process',
        payload: { batchSize: 10 },
      });
      expect(res.statusCode).toBe(401);
    });

    it('POST /v1/internal/notifications/process rejects invalid credentials', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/notifications/process',
        headers: { 'x-internal-service-key': 'invalid-secret-key-123' },
        payload: { batchSize: 10 },
      });
      expect(res.statusCode).toBe(401);
    });

    it('POST /v1/internal/notifications/process validates bounded options', async () => {
      const badBatch = await app.inject({
        method: 'POST',
        url: '/v1/internal/notifications/process',
        headers: { 'x-internal-service-key': internalKey },
        payload: { batchSize: 0 },
      });
      expect(badBatch.statusCode).toBe(400);

      const excessiveBatch = await app.inject({
        method: 'POST',
        url: '/v1/internal/notifications/process',
        headers: { 'x-internal-service-key': internalKey },
        payload: { batchSize: 1000 },
      });
      expect(excessiveBatch.statusCode).toBe(400);

      const badDelay = await app.inject({
        method: 'POST',
        url: '/v1/internal/notifications/process',
        headers: { 'x-internal-service-key': internalKey },
        payload: { baseRetryDelayMs: 20 },
      });
      expect(badDelay.statusCode).toBe(400);
    });

    it('POST /v1/internal/notifications/process dispatches queued notifications when authorized', async () => {
      // First enqueue a notification via internal API
      await app.inject({
        method: 'POST',
        url: '/v1/internal/notifications/request',
        headers: { 'x-internal-service-key': internalKey },
        payload: {
          tenantId: 'ten-1',
          eventId: 'evt-batch-1',
          notificationType: 'ORDER_CONFIRMATION',
          channel: 'EMAIL',
          recipient: 'process-internal@test.com',
          payload: { orderId: 'ord-batch-1' },
        },
      });

      // Trigger internal process endpoint
      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/notifications/process',
        headers: { 'x-internal-service-key': internalKey },
        payload: { batchSize: 10, baseRetryDelayMs: 1000 },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json).toHaveProperty('claimed');
      expect(json).toHaveProperty('sent');
      expect(json).toHaveProperty('failed');
      expect(json).toHaveProperty('deadLettered');
      expect(json.sent).toBeGreaterThanOrEqual(1);
    });

    it('POST /v1/internal/events/ingest rejects unauthenticated requests', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        payload: {
          eventId: 'evt-test-1',
          eventType: 'order.created.v1',
          eventVersion: 1,
          aggregateType: 'order',
          aggregateId: 'ord-1',
          tenantId: 'ten-1',
          occurredAt: new Date().toISOString(),
          payload: { customerEmail: 'buyer@test.com' },
          metadata: { source: 'test' },
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('POST /v1/internal/events/ingest rejects invalid internal credentials', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': 'wrong-key-123456789' },
        payload: {
          eventId: 'evt-test-1',
          eventType: 'order.created.v1',
          eventVersion: 1,
          aggregateType: 'order',
          aggregateId: 'ord-1',
          tenantId: 'ten-1',
          occurredAt: new Date().toISOString(),
          payload: { customerEmail: 'buyer@test.com' },
          metadata: { source: 'test' },
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('POST /v1/internal/events/ingest validates domain event envelope fields', async () => {
      const basePayload = {
        eventId: 'evt-valid-1',
        eventType: 'order.created.v1',
        eventVersion: 1,
        aggregateType: 'order',
        aggregateId: 'ord-1',
        tenantId: 'ten-1',
        occurredAt: new Date().toISOString(),
        payload: { customerEmail: 'buyer@test.com' },
        metadata: { source: 'test' },
      };

      // Non-object body
      const badBody = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: ['not-an-object'],
      });
      expect(badBody.statusCode).toBe(400);

      // Missing eventId
      const noEventId = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: { ...basePayload, eventId: '' },
      });
      expect(noEventId.statusCode).toBe(400);

      // Missing eventType
      const noEventType = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: { ...basePayload, eventType: '' },
      });
      expect(noEventType.statusCode).toBe(400);

      // Invalid eventVersion
      const badVersion = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: { ...basePayload, eventVersion: 0 },
      });
      expect(badVersion.statusCode).toBe(400);

      // Missing tenantId
      const noTenant = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: { ...basePayload, tenantId: '' },
      });
      expect(noTenant.statusCode).toBe(400);

      // Invalid occurredAt
      const badDate = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: { ...basePayload, occurredAt: 'invalid-date' },
      });
      expect(badDate.statusCode).toBe(400);

      // Missing payload
      const noPayload = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: { ...basePayload, payload: null },
      });
      expect(noPayload.statusCode).toBe(400);
    });

    it('POST /v1/internal/events/ingest rejects unsupported event version before processing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: {
          eventId: `evt-unsupported-${Date.now()}`,
          eventType: 'order.created.v1',
          eventVersion: 2, // Unsupported version
          aggregateType: 'order',
          aggregateId: 'ord-unsupported',
          tenantId: 'ten-1',
          occurredAt: new Date().toISOString(),
          payload: { customerEmail: 'test@example.com' },
          metadata: { source: 'test' },
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('VALIDATION_FAILED');
      expect(json.error.message).toContain(
        "Unsupported event version 2 for event type 'order.created.v1'",
      );
    });

    it('POST /v1/internal/events/ingest rejects sensitive keys in payload before processing', async () => {
      // 1. Top-level sensitive key
      const resPassword = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: {
          eventId: `evt-sensitive-1-${Date.now()}`,
          eventType: 'order.created.v1',
          eventVersion: 1,
          aggregateType: 'order',
          aggregateId: 'ord-sensitive-1',
          tenantId: 'ten-1',
          occurredAt: new Date().toISOString(),
          payload: {
            customerEmail: 'test@example.com',
            password: 'plaintext-secret',
          },
          metadata: { source: 'test' },
        },
      });
      expect(resPassword.statusCode).toBe(400);
      expect(resPassword.json().error.message).toContain(
        "Prohibited sensitive key 'password' detected",
      );

      // 2. Nested sensitive key
      const resNestedToken = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: {
          eventId: `evt-sensitive-2-${Date.now()}`,
          eventType: 'order.created.v1',
          eventVersion: 1,
          aggregateType: 'order',
          aggregateId: 'ord-sensitive-2',
          tenantId: 'ten-1',
          occurredAt: new Date().toISOString(),
          payload: {
            customerEmail: 'test@example.com',
            authDetails: {
              refresh_token: 'rf_xyz_secret',
            },
          },
          metadata: { source: 'test' },
        },
      });
      expect(resNestedToken.statusCode).toBe(400);
      expect(resNestedToken.json().error.message).toContain(
        "Prohibited sensitive key 'authDetails.refresh_token' detected",
      );

      // 3. Credit card sensitive key
      const resCard = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: {
          eventId: `evt-sensitive-3-${Date.now()}`,
          eventType: 'payment.succeeded.v1',
          eventVersion: 1,
          aggregateType: 'payment',
          aggregateId: 'pi-sensitive-3',
          tenantId: 'ten-1',
          occurredAt: new Date().toISOString(),
          payload: {
            customerEmail: 'test@example.com',
            payment: {
              card_number: '4111222233334444',
            },
          },
          metadata: { source: 'test' },
        },
      });
      expect(resCard.statusCode).toBe(400);
      expect(resCard.json().error.message).toContain(
        "Prohibited sensitive key 'payment.card_number' detected",
      );
    });

    it('POST /v1/internal/events/ingest requires metadata and validates metadata fields', async () => {
      const basePayload = {
        eventId: `evt-meta-${Date.now()}`,
        eventType: 'order.created.v1',
        eventVersion: 1,
        aggregateType: 'order',
        aggregateId: 'ord-meta',
        tenantId: 'ten-1',
        occurredAt: new Date().toISOString(),
        payload: { customerEmail: 'meta@example.com' },
      };

      // 1. Missing metadata
      const resMissing = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: basePayload,
      });
      expect(resMissing.statusCode).toBe(400);
      expect(resMissing.json().error.message).toContain(
        'metadata is required and must be an object',
      );

      // 2. Non-object metadata
      const resNonObject = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: { ...basePayload, metadata: 'invalid-string' },
      });
      expect(resNonObject.statusCode).toBe(400);
      expect(resNonObject.json().error.message).toContain(
        'metadata is required and must be an object',
      );

      // 3. Non-string metadata.correlationId
      const resBadCorrelation = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: { ...basePayload, metadata: { correlationId: 12345 } },
      });
      expect(resBadCorrelation.statusCode).toBe(400);
      expect(resBadCorrelation.json().error.message).toContain(
        'metadata.correlationId must be a string if provided',
      );
    });

    it('POST /v1/internal/events/ingest processes newly processed event and preserves metadata', async () => {
      const eventId = `evt-new-${Date.now()}`;
      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: {
          eventId,
          eventType: 'order.created.v1',
          eventVersion: 1,
          aggregateType: 'order',
          aggregateId: 'order-new-1',
          tenantId: 'ten-1',
          occurredAt: new Date().toISOString(),
          payload: {
            customerEmail: 'ingest-test@example.com',
            customerId: 'cust-123',
            totalAmount: 250,
          },
          metadata: {
            correlationId: 'corr-abc-123',
            causationId: 'caus-def-456',
            actorId: 'user-789',
            source: 'monolith-bridge',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json).toEqual({
        status: 'PROCESSED',
        eventId,
        handled: true,
        duplicate: false,
      });

      // Verify notification created in repository
      const repo = new NotificationRepository(db);
      const notifs = await repo.listNotifications({ tenantId: 'ten-1' });
      const found = notifs.items.find((n) => n.eventId === eventId);
      expect(found).toBeDefined();
      expect(found?.notificationType).toBe('ORDER_CONFIRMATION');
      expect(found?.recipient).toBe('ingest-test@example.com');
      // User-visible payload must NOT contain internal tracing fields
      expect(found?.payload).not.toHaveProperty('correlationId');
      expect(found?.payload).not.toHaveProperty('causationId');

      // Verify consumer receipt was recorded as COMPLETED with metadata preserved
      const receipt = await repo.findReceipt('notification-dispatcher', eventId);
      expect(receipt).toBeDefined();
      expect(receipt?.status).toBe('COMPLETED');
      expect(receipt?.errorMetadata).toMatchObject({
        metadata: {
          correlationId: 'corr-abc-123',
          causationId: 'caus-def-456',
          actorId: 'user-789',
          source: 'monolith-bridge',
        },
      });
    });

    it('POST /v1/internal/events/ingest returns 200 ALREADY_COMPLETED on duplicate delivery and redelivery', async () => {
      const eventId = `evt-dedup-${Date.now()}`;
      const eventBody = {
        eventId,
        eventType: 'order.created.v1',
        eventVersion: 1,
        aggregateType: 'order',
        aggregateId: 'order-dedup-1',
        tenantId: 'ten-1',
        occurredAt: new Date().toISOString(),
        payload: {
          customerEmail: 'dedup@example.com',
          totalAmount: 100,
        },
        metadata: { correlationId: 'corr-dedup-1', source: 'monolith' },
      };

      // 1. First run: PROCESSED
      const firstRes = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: eventBody,
      });
      expect(firstRes.statusCode).toBe(200);
      expect(firstRes.json()).toEqual({
        status: 'PROCESSED',
        eventId,
        handled: true,
        duplicate: false,
      });

      const repo = new NotificationRepository(db);
      const notifsCountBefore = (await repo.listNotifications({ tenantId: 'ten-1' })).total;

      // 2. Second run: ALREADY_COMPLETED (duplicate: true)
      const secondRes = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: eventBody,
      });
      expect(secondRes.statusCode).toBe(200);
      expect(secondRes.json()).toEqual({
        status: 'ALREADY_COMPLETED',
        eventId,
        handled: false,
        duplicate: true,
      });

      // 3. Redelivery simulation (caller lost response and retried)
      const thirdRes = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: eventBody,
      });
      expect(thirdRes.statusCode).toBe(200);
      expect(thirdRes.json()).toEqual({
        status: 'ALREADY_COMPLETED',
        eventId,
        handled: false,
        duplicate: true,
      });

      // Assert no duplicate notification was created
      const notifsCountAfter = (await repo.listNotifications({ tenantId: 'ten-1' })).total;
      expect(notifsCountAfter).toBe(notifsCountBefore);
    });

    it('POST /v1/internal/events/ingest returns 409 CURRENTLY_PROCESSING when event is actively claimed by another worker', async () => {
      const eventId = `evt-concurrent-${Date.now()}`;
      const repo = new NotificationRepository(db);

      // Pre-claim the event as actively PROCESSING
      const claim = await repo.claimEventReceipt('notification-dispatcher', eventId, {
        staleTimeoutMs: 5 * 60 * 1000,
      });
      expect(claim.claimed).toBe(true);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: {
          eventId,
          eventType: 'order.created.v1',
          eventVersion: 1,
          aggregateType: 'order',
          aggregateId: 'ord-conc-1',
          tenantId: 'ten-1',
          occurredAt: new Date().toISOString(),
          payload: { customerEmail: 'concurrent@example.com' },
          metadata: { correlationId: 'corr-conc-1', source: 'monolith' },
        },
      });

      // Must return HTTP 409, so caller does NOT prematurely acknowledge
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        status: 'CURRENTLY_PROCESSING',
        eventId,
        handled: false,
        duplicate: true,
        error: 'Event is currently being processed by another worker',
      });
    });

    it('POST /v1/internal/events/ingest returns 500 FAILED on handler failure and allows subsequent retry', async () => {
      let fail = true;

      class FlakyConsumer extends NotificationEventConsumer {
        protected override async handleEvent(evt: DomainEvent): Promise<void> {
          if (fail) {
            throw new Error('Downstream provider connection failure with token=top-secret-abc');
          }
          return super.handleEvent(evt);
        }
      }

      const repo = new NotificationRepository(db);
      const flakyConsumer = new FlakyConsumer(
        new NotificationService(repo, {
          email: new InMemoryEmailProvider(),
          sms: new InMemorySmsProvider(),
          push: new InMemoryPushProvider(),
        }),
        repo,
      );

      const customApp = buildApp({
        config: testConfig,
        db,
        eventConsumer: flakyConsumer,
      });
      await customApp.ready();

      const eventId = `evt-flaky-${Date.now()}`;
      const eventBody = {
        eventId,
        eventType: 'order.created.v1',
        eventVersion: 1,
        aggregateType: 'order',
        aggregateId: 'order-flaky-1',
        tenantId: 'ten-1',
        occurredAt: new Date().toISOString(),
        payload: { customerEmail: 'flaky@example.com' },
        metadata: { correlationId: 'corr-flaky-1', source: 'monolith' },
      };

      // 1. Initial attempt fails -> 500
      const failRes = await customApp.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: eventBody,
      });

      expect(failRes.statusCode).toBe(500);
      const failJson = failRes.json();
      expect(failJson.status).toBe('FAILED');
      expect(failJson.eventId).toBe(eventId);
      expect(failJson.error.message).toContain('Downstream provider connection failure');
      // Verify sensitive token in error was sanitized
      expect(failJson.error.message).not.toContain('top-secret-abc');
      expect(failJson.error.message).toContain('[REDACTED]');

      // Verify the receipt was marked FAILED with metadata
      const receipt = await repo.findReceipt('notification-dispatcher', eventId);
      expect(receipt?.status).toBe('FAILED');
      expect(receipt?.errorMetadata).toMatchObject({
        error: expect.stringContaining('Downstream provider connection failure'),
        metadata: { correlationId: 'corr-flaky-1', source: 'monolith' },
      });

      // 2. Retry after downstream recovers -> 200 PROCESSED
      fail = false;
      const retryRes = await customApp.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: eventBody,
      });

      expect(retryRes.statusCode).toBe(200);
      expect(retryRes.json()).toEqual({
        status: 'PROCESSED',
        eventId,
        handled: true,
        duplicate: false,
      });

      // Verify receipt transitioned to COMPLETED
      const finalReceipt = await repo.findReceipt('notification-dispatcher', eventId);
      expect(finalReceipt?.status).toBe('COMPLETED');

      await customApp.close();
    });

    it('POST /v1/internal/events/ingest enforces claim fencing: returns 500 FAILED if claim superseded by another worker', async () => {
      let slowStartedResolve: () => void;
      const slowStartedPromise = new Promise<void>((resolve) => {
        slowStartedResolve = resolve;
      });

      let reclaimDoneResolve: () => void;
      const reclaimDonePromise = new Promise<void>((resolve) => {
        reclaimDoneResolve = resolve;
      });

      class FencedConsumer extends NotificationEventConsumer {
        protected override async handleEvent(evt: DomainEvent): Promise<void> {
          slowStartedResolve();
          await reclaimDonePromise;
          return super.handleEvent(evt);
        }
      }

      const repo = new NotificationRepository(db);
      const fencedConsumer = new FencedConsumer(
        new NotificationService(repo, {
          email: new InMemoryEmailProvider(),
          sms: new InMemorySmsProvider(),
          push: new InMemoryPushProvider(),
        }),
        repo,
        undefined,
        { staleTimeoutMs: 60 * 1000 },
      );

      const customApp = buildApp({
        config: testConfig,
        db,
        eventConsumer: fencedConsumer,
      });
      await customApp.ready();

      const eventId = `evt-fence-${Date.now()}`;
      const eventBody = {
        eventId,
        eventType: 'order.created.v1',
        eventVersion: 1,
        aggregateType: 'order',
        aggregateId: 'order-fence-1',
        tenantId: 'ten-1',
        occurredAt: new Date().toISOString(),
        payload: { customerEmail: 'fence@example.com' },
        metadata: { correlationId: 'corr-fence-1', source: 'monolith' },
      };

      // 1. Worker A begins processing via HTTP
      const workerAPromise = customApp.inject({
        method: 'POST',
        url: '/v1/internal/events/ingest',
        headers: { 'x-internal-service-key': internalKey },
        payload: eventBody,
      });

      await slowStartedPromise;

      // 2. While Worker A is inside handleEvent, age the receipt to simulate worker hang
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await db.query(
        `UPDATE notification_consumer_receipts SET processed_at = $1 WHERE event_id = $2`,
        [tenMinutesAgo, eventId],
      );

      // 3. Worker B reclaims and successfully completes the event
      const workerB = new NotificationEventConsumer(
        new NotificationService(repo, {
          email: new InMemoryEmailProvider(),
          sms: new InMemorySmsProvider(),
          push: new InMemoryPushProvider(),
        }),
        repo,
        undefined,
        { staleTimeoutMs: 60 * 1000 },
      );
      const resB = await workerB.process({
        eventId,
        eventType: 'order.created.v1',
        eventVersion: 1,
        aggregateType: 'order',
        aggregateId: 'order-fence-1',
        tenantId: 'ten-1',
        occurredAt: new Date().toISOString(),
        payload: { customerEmail: 'fence@example.com' },
        metadata: { correlationId: 'corr-fence-1', source: 'monolith' },
      });
      expect(resB.status).toBe('PROCESSED');

      // 4. Release Worker A
      reclaimDoneResolve!();
      const resA = await workerAPromise;

      // Worker A must return HTTP 500 FAILED because its claim was superseded!
      expect(resA.statusCode).toBe(500);
      const jsonA = resA.json();
      expect(jsonA.status).toBe('FAILED');
      expect(jsonA.error.message).toContain(
        'Event processing claim was superseded by another worker',
      );

      // Receipt must remain COMPLETED by Worker B
      const receipt = await repo.findReceipt('notification-dispatcher', eventId);
      expect(receipt?.status).toBe('COMPLETED');

      await customApp.close();
    });
  });

  describe('Admin Notification Management APIs', () => {
    it('GET /notifications requires ADMINISTRATOR role', async () => {
      const noAuthRes = await app.inject({ method: 'GET', url: '/notifications' });
      expect(noAuthRes.statusCode).toBe(401);

      const custRes = await app.inject({
        method: 'GET',
        url: '/notifications',
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(custRes.statusCode).toBe(403);

      const adminRes = await app.inject({
        method: 'GET',
        url: '/notifications',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(adminRes.statusCode).toBe(200);
      expect(adminRes.json()).toHaveProperty('data');
    });

    it('GET /notifications/:id, POST /notifications/process, POST /notifications/:id/retry', async () => {
      // Create a notification via internal API
      const createRes = await app.inject({
        method: 'POST',
        url: '/v1/internal/notifications/request',
        headers: { 'x-internal-service-key': internalKey },
        payload: {
          tenantId: 'ten-1',
          eventId: 'evt-admin-1',
          notificationType: 'ORDER_CONFIRMATION',
          channel: 'EMAIL',
          recipient: 'buyer@test.com',
          payload: { orderId: 'ord-999' },
        },
      });
      const notificationId = createRes.json().notificationId;

      // GET /notifications/:id
      const getRes = await app.inject({
        method: 'GET',
        url: `/notifications/${notificationId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().id).toBe(notificationId);

      // POST /notifications/process
      const processRes = await app.inject({
        method: 'POST',
        url: '/notifications/process',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { batchSize: 10 },
      });
      expect(processRes.statusCode).toBe(200);
      expect(processRes.json().processed).toBe(1);

      // Update status to DEAD_LETTERED so it is eligible for retry
      await db.query(`UPDATE notifications SET status = 'DEAD_LETTERED' WHERE id = $1`, [
        notificationId,
      ]);

      // POST /notifications/:id/retry
      const retryRes = await app.inject({
        method: 'POST',
        url: `/notifications/${notificationId}/retry`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(retryRes.statusCode).toBe(200);
      expect(retryRes.json().status).toBe('PENDING');
    });
  });

  describe('Customer Preference APIs', () => {
    it('GET and PUT /customers/me/notification-preferences', async () => {
      // Initial GET returns defaults
      const getInitRes = await app.inject({
        method: 'GET',
        url: '/customers/me/notification-preferences',
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(getInitRes.statusCode).toBe(200);
      expect(getInitRes.json().emailEnabled).toBe(true);

      // PUT updates preferences
      const putRes = await app.inject({
        method: 'PUT',
        url: '/customers/me/notification-preferences',
        headers: { authorization: `Bearer ${customerToken}` },
        payload: {
          emailEnabled: true,
          smsEnabled: false,
          pushEnabled: false,
          disabledTypes: ['PRICE_DROP_ALERT'],
        },
      });
      expect(putRes.statusCode).toBe(200);
      expect(putRes.json().smsEnabled).toBe(false);

      // Subsequent GET returns saved preferences
      const getUpdatedRes = await app.inject({
        method: 'GET',
        url: '/customers/me/notification-preferences',
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(getUpdatedRes.statusCode).toBe(200);
      expect(getUpdatedRes.json().smsEnabled).toBe(false);
      expect(getUpdatedRes.json().disabledTypes).toEqual(['PRICE_DROP_ALERT']);
    });
  });
});
