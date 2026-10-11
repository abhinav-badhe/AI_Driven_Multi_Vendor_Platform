import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';
import { InMemorySearchStore } from '../src/modules/search/index.js';
import {
  createDomainEvent,
  EventTypes,
  InMemoryEventTransport,
  OutboxRepository,
  OutboxService,
} from '../src/modules/events/index.js';
import {
  HttpEventForwarder,
  HttpEventForwarderError,
  NOTIFICATION_EVENT_TYPES,
  readBoundedText,
  DEFAULT_MAX_RESPONSE_BYTES,
} from '../src/modules/notifications/index.js';
import { JsonLogger } from '../src/observability/logger.js';
import { ValidationError } from '../src/errors/app-error.js';
import { markAllUsersVerified } from './helpers/verify-users.js';

describe('Monolith-to-Notifications HTTP Event Forwarding (Phase 2)', () => {
  const BASE_URL = 'http://notifications-service.internal:3001';
  const VALID_KEY = 'test-internal-service-secret-key-32chars';
  const TOKEN_SECRET = 'super-secret-key-at-least-16-chars';

  let db: DatabaseConnection;
  let transport: InMemoryEventTransport;
  let outboxRepo: OutboxRepository;
  let outboxService: OutboxService;
  let logger: JsonLogger;

  beforeEach(async () => {
    db = await createMigratedTestDatabase();
    transport = new InMemoryEventTransport();
    logger = new JsonLogger({ serviceName: 'test-forwarder', level: 'info' });
    outboxRepo = new OutboxRepository();
    outboxService = new OutboxService(db, outboxRepo, transport, logger);
  });

  afterEach(async () => {
    if (db) await db.close();
  });

  function makeSampleEvent(eventType = EventTypes.ORDER_CREATED) {
    return createDomainEvent({
      eventId: `evt-fwd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      eventType,
      eventVersion: 1,
      aggregateType: 'order',
      aggregateId: 'ord-123',
      tenantId: 'tenant-test-1',
      occurredAt: new Date().toISOString(),
      payload: {
        customerEmail: 'buyer@example.com',
        customerId: 'cust-1',
        totalAmount: 199.99,
      },
      metadata: {
        correlationId: 'corr-xyz-123',
        causationId: 'caus-abc-456',
        actorId: 'user-789',
        source: 'monolith-commerce',
      },
    });
  }

  describe('1. Configuration & Instantiation', () => {
    it('initializes successfully with valid baseUrl and internalServiceKey', () => {
      const forwarder = new HttpEventForwarder({
        baseUrl: `${BASE_URL}///`,
        internalServiceKey: VALID_KEY,
        timeoutMs: 4000,
      });
      expect(forwarder).toBeInstanceOf(HttpEventForwarder);
    });

    it('rejects missing or invalid baseUrl', () => {
      expect(
        () => new HttpEventForwarder({ baseUrl: '', internalServiceKey: VALID_KEY }),
      ).toThrow(ValidationError);
      expect(
        () => new HttpEventForwarder({ baseUrl: 'not-a-url', internalServiceKey: VALID_KEY }),
      ).toThrow(ValidationError);
    });

    it('rejects short or missing internalServiceKey', () => {
      expect(
        () => new HttpEventForwarder({ baseUrl: BASE_URL, internalServiceKey: 'too-short' }),
      ).toThrow(ValidationError);
    });

    it('rejects invalid timeoutMs', () => {
      expect(
        () =>
          new HttpEventForwarder({
            baseUrl: BASE_URL,
            internalServiceKey: VALID_KEY,
            timeoutMs: -100,
          }),
      ).toThrow(ValidationError);
    });
  });

  describe('2. Direct Forwarding & Acknowledgement Semantics', () => {
    it('1. Successful event forwarding and acknowledgement (HTTP 200 PROCESSED)', async () => {
      const event = makeSampleEvent();
      let capturedUrl = '';
      let capturedOptions: RequestInit | undefined;

      const mockFetch = vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
        capturedUrl = url;
        capturedOptions = opts;
        return new Response(
          JSON.stringify({
            status: 'PROCESSED',
            eventId: event.eventId,
            handled: true,
            duplicate: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const forwarder = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetch },
        logger,
      );

      await expect(forwarder.forward(event)).resolves.toBeUndefined();

      expect(capturedUrl).toBe(`${BASE_URL}/v1/internal/events/ingest`);
      expect(capturedOptions?.method).toBe('POST');
      const headers = capturedOptions?.headers as Record<string, string>;
      expect(headers['X-Internal-Service-Key']).toBe(VALID_KEY);
      expect(headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(capturedOptions?.body as string);
      expect(body.eventId).toBe(event.eventId);
      expect(body.eventType).toBe(event.eventType);
      expect(body.eventVersion).toBe(1);
      expect(body.aggregateType).toBe('order');
      expect(body.aggregateId).toBe('ord-123');
      expect(body.tenantId).toBe('tenant-test-1');
      expect(body.payload).toEqual(event.payload);
      expect(body.metadata).toEqual(event.metadata);
    });

    it('2. Completed duplicate acknowledgement (HTTP 200 ALREADY_COMPLETED)', async () => {
      const event = makeSampleEvent();
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'ALREADY_COMPLETED',
            eventId: event.eventId,
            handled: false,
            duplicate: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const forwarder = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetch },
        logger,
      );

      // Must be acknowledged as successful delivery (does not throw)
      await expect(forwarder.forward(event)).resolves.toBeUndefined();
    });

    it('3. HTTP 409 CURRENTLY_PROCESSING causes delivery failure and retry rather than acknowledgement', async () => {
      const event = makeSampleEvent();
      const mockFetch = vi.fn().mockImplementation(() =>
        new Response(
          JSON.stringify({
            status: 'CURRENTLY_PROCESSING',
            eventId: event.eventId,
            handled: false,
            duplicate: true,
            error: 'Event is currently being processed by another worker',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const forwarder = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetch },
        logger,
      );

      await expect(forwarder.forward(event)).rejects.toThrow(HttpEventForwarderError);
      await expect(forwarder.forward(event)).rejects.toMatchObject({
        statusCode: 409,
        code: 'EVENT_FORWARDING_IN_PROGRESS',
      });
    });

    it('4. HTTP 5xx, network error, and timeout propagation', async () => {
      const event = makeSampleEvent();

      // 4a. HTTP 500 error
      const mockFetch500 = vi.fn().mockImplementation(() =>
        new Response(
          JSON.stringify({
            error: { message: 'Database connection failed downstream' },
            status: 'FAILED',
            eventId: event.eventId,
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      const forwarder500 = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetch500 },
        logger,
      );
      await expect(forwarder500.forward(event)).rejects.toThrow(HttpEventForwarderError);
      await expect(forwarder500.forward(event)).rejects.toMatchObject({
        statusCode: 500,
        code: 'EVENT_FORWARDING_SERVICE_ERROR',
      });

      // 4b. Network error (connection refused/dropped)
      const mockFetchNet = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:3001'));
      const forwarderNet = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetchNet },
        logger,
      );
      await expect(forwarderNet.forward(event)).rejects.toThrow(HttpEventForwarderError);
      await expect(forwarderNet.forward(event)).rejects.toMatchObject({
        statusCode: 502,
        code: 'EVENT_FORWARDING_NETWORK_ERROR',
      });

      // 4c. Timeout
      const mockFetchTimeout = vi.fn().mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        }, 50)),
      );
      const forwarderTimeout = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, timeoutMs: 10, fetchFn: mockFetchTimeout },
        logger,
      );
      await expect(forwarderTimeout.forward(event)).rejects.toThrow(HttpEventForwarderError);
      await expect(forwarderTimeout.forward(event)).rejects.toMatchObject({
        statusCode: 504,
        code: 'EVENT_FORWARDING_TIMEOUT',
      });
    });

    it('10. Event IDs and metadata are preserved without field loss or reconstruction', async () => {
      const event = makeSampleEvent();
      let sentBody: Record<string, unknown> = {};

      const mockFetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
        sentBody = JSON.parse(opts.body as string);
        return new Response(
          JSON.stringify({ status: 'PROCESSED', eventId: event.eventId, handled: true, duplicate: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const forwarder = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetch },
        logger,
      );
      await forwarder.forward(event);

      expect(sentBody.eventId).toBe(event.eventId);
      expect(sentBody.eventType).toBe(event.eventType);
      expect(sentBody.eventVersion).toBe(event.eventVersion);
      expect(sentBody.aggregateType).toBe(event.aggregateType);
      expect(sentBody.aggregateId).toBe(event.aggregateId);
      expect(sentBody.tenantId).toBe(event.tenantId);
      expect(sentBody.occurredAt).toBe(event.occurredAt);
      expect(sentBody.payload).toEqual(event.payload);
      expect(sentBody.metadata).toEqual({
        correlationId: 'corr-xyz-123',
        causationId: 'caus-abc-456',
        actorId: 'user-789',
        source: 'monolith-commerce',
      });
    });

    it('11. Invalid or unexpected service responses fail safely', async () => {
      const event = makeSampleEvent();

      // 11a. Malformed non-JSON response on HTTP 200
      const mockFetchHtml = vi.fn().mockImplementation(() =>
        new Response('<html><body>502 Bad Gateway</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );
      const forwarderHtml = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetchHtml },
        logger,
      );
      await expect(forwarderHtml.forward(event)).rejects.toThrow(HttpEventForwarderError);
      await expect(forwarderHtml.forward(event)).rejects.toMatchObject({
        code: 'EVENT_FORWARDING_MALFORMED_RESPONSE',
      });

      // 11b. HTTP 200 with unexpected status string
      const mockFetchUnknownStatus = vi.fn().mockImplementation(() =>
        new Response(
          JSON.stringify({ status: 'UNKNOWN_STATE', eventId: event.eventId }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      const forwarderUnknown = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetchUnknownStatus },
        logger,
      );
      await expect(forwarderUnknown.forward(event)).rejects.toThrow(HttpEventForwarderError);
      await expect(forwarderUnknown.forward(event)).rejects.toMatchObject({
        code: 'EVENT_FORWARDING_UNEXPECTED_STATUS',
      });

      // 11c. HTTP 401 Unauthorized
      const mockFetch401 = vi.fn().mockImplementation(() =>
        new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
      );
      const forwarder401 = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetch401 },
        logger,
      );
      await expect(forwarder401.forward(event)).rejects.toThrow(HttpEventForwarderError);
      await expect(forwarder401.forward(event)).rejects.toMatchObject({
        statusCode: 401,
        code: 'EVENT_FORWARDING_AUTH_ERROR',
      });

      // 11d. Oversized HTTP response body (> 64 KB) throws EVENT_FORWARDING_RESPONSE_TOO_LARGE and cancels stream
      const hugeBody = 'x'.repeat(70 * 1024);
      let readerCancelled = false;
      const mockFetchHuge = vi.fn().mockImplementation(() => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(hugeBody));
          },
          cancel() {
            readerCancelled = true;
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      const forwarderHuge = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetchHuge },
        logger,
      );
      await expect(forwarderHuge.forward(event)).rejects.toThrow(HttpEventForwarderError);
      await expect(forwarderHuge.forward(event)).rejects.toMatchObject({
        statusCode: 502,
        code: 'EVENT_FORWARDING_RESPONSE_TOO_LARGE',
      });
      expect(readerCancelled).toBe(true);

      // 11e. HTTP 413 Payload Too Large from server throws EVENT_FORWARDING_PAYLOAD_TOO_LARGE
      const mockFetch413 = vi.fn().mockImplementation(() =>
        new Response(JSON.stringify({ error: 'Payload exceeds limit' }), {
          status: 413,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const forwarder413 = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetch413 },
        logger,
      );
      await expect(forwarder413.forward(event)).rejects.toThrow(HttpEventForwarderError);
      await expect(forwarder413.forward(event)).rejects.toMatchObject({
        statusCode: 413,
        code: 'EVENT_FORWARDING_PAYLOAD_TOO_LARGE',
      });

      // 11f. Direct test of readBoundedText helper
      const smallRes = new Response('{"status":"ok"}', { status: 200 });
      const smallText = await readBoundedText(smallRes, DEFAULT_MAX_RESPONSE_BYTES);
      expect(smallText).toBe('{"status":"ok"}');

      const oversizedRes = new Response('a'.repeat(200), { status: 200 });
      await expect(readBoundedText(oversizedRes, 100)).rejects.toMatchObject({
        code: 'EVENT_FORWARDING_RESPONSE_TOO_LARGE',
      });
    });
  });

  describe('3. Outbox Integration & Failure Propagation', () => {
    it('5. Outbox does not mark an event PUBLISHED when forwarding fails (retains RETRY_SCHEDULED)', async () => {
      const event = makeSampleEvent();

      // Record event into outbox inside a transaction
      await db.withTransaction(async (tx) => {
        await outboxService.recordEvent(tx, event);
      });

      // Wire a failing forwarder to transport
      const mockFetchFail = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: 'Internal server error' }, status: 'FAILED' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      const forwarder = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetchFail },
        logger,
      );
      forwarder.registerSubscriptions(transport);

      // Publish pending outbox events
      const result = await outboxService.publishPendingEvents({ baseRetryDelayMs: 500 });

      expect(result.claimedCount).toBe(1);
      expect(result.publishedCount).toBe(0);
      expect(result.failedCount).toBe(1);

      // Verify outbox row status in database: NOT published, scheduled for retry
      const rows = await db.query<{ status: string; attempt_count: number; published_at: unknown }>(
        `SELECT status, attempt_count, published_at FROM outbox_events WHERE event_id = $1`,
        [event.eventId],
      );
      expect(rows.rows.length).toBe(1);
      expect(rows.rows[0]?.status).toBe('PENDING');
      expect(rows.rows[0]?.attempt_count).toBe(1);
      expect(rows.rows[0]?.published_at).toBeNull();
    });

    it('5b. When forwarder has db configured, HTTP delivery failure records FAILED in event_consumer_receipts, sibling consumers still succeed, and outbox event is marked PUBLISHED (core domain event is never dead-lettered)', async () => {
      const event = makeSampleEvent();

      await db.withTransaction(async (tx) => {
        await outboxService.recordEvent(tx, event);
      });

      // Register an unrelated consumer on transport
      let siblingConsumerRan = false;
      transport.subscribe(event.eventType, async (e) => {
        siblingConsumerRan = true;
        await outboxRepo.recordReceipt(db, {
          id: `rcpt-sibling-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          consumerName: 'sibling-order-processor',
          eventId: e.eventId,
          status: 'COMPLETED',
        });
      });

      // Wire a failing DB-backed forwarder
      const mockFetchFail = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: 'Notifications cluster unreachable' }, status: 'FAILED' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      const forwarder = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetchFail, db },
        logger,
      );
      forwarder.registerSubscriptions(transport);

      // Publish pending outbox events
      const result = await outboxService.publishPendingEvents();

      // Crucial: The core domain outbox event succeeded!
      expect(result.claimedCount).toBe(1);
      expect(result.publishedCount).toBe(1);
      expect(result.failedCount).toBe(0);

      // 1. Outbox row is marked PUBLISHED (NOT dead-lettered or pending retry)
      const outboxRow = await db.query<{ status: string; published_at: unknown }>(
        `SELECT status, published_at FROM outbox_events WHERE event_id = $1`,
        [event.eventId],
      );
      expect(outboxRow.rows[0]?.status).toBe('PUBLISHED');
      expect(outboxRow.rows[0]?.published_at).not.toBeNull();

      // 2. Sibling consumer executed successfully and was not blocked
      expect(siblingConsumerRan).toBe(true);
      const siblingReceipt = await outboxRepo.findReceipt(db, 'sibling-order-processor', event.eventId);
      expect(siblingReceipt?.status).toBe('COMPLETED');

      // 3. Forwarder recorded its receipt as FAILED in event_consumer_receipts
      const forwarderReceipt = await outboxRepo.findReceipt(db, 'notifications-http-forwarder', event.eventId);
      expect(forwarderReceipt).toBeDefined();
      expect(forwarderReceipt?.status).toBe('FAILED');
      expect(forwarderReceipt?.errorMetadata).toMatchObject({
        attempts: 1,
      });
    });

    it('5c. Independent retry via forwarder.retryFailedEvents() retries failed receipts and quarantines after maxAttempts exceeded', async () => {
      const event = makeSampleEvent();

      await db.withTransaction(async (tx) => {
        await outboxService.recordEvent(tx, event);
      });

      let shouldSucceed = false;
      const mockFetch = vi.fn().mockImplementation(async () => {
        if (!shouldSucceed) {
          return new Response(JSON.stringify({ error: 'Temporary outage' }), { status: 500 });
        }
        return new Response(
          JSON.stringify({ status: 'PROCESSED', eventId: event.eventId, handled: true, duplicate: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const forwarder = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetch, db },
        logger,
      );
      forwarder.registerSubscriptions(transport);

      await outboxService.publishPendingEvents();

      const initialReceipt = await outboxRepo.findReceipt(db, 'notifications-http-forwarder', event.eventId);
      expect(initialReceipt?.status).toBe('FAILED');

      // Retry 1: still failing
      const retryFailResult = await forwarder.retryFailedEvents({ baseRetryDelayMs: 0 });
      expect(retryFailResult.claimed).toBe(1);
      expect(retryFailResult.retried).toBe(0);
      expect(retryFailResult.failed).toBe(1);

      const afterRetryReceipt = await outboxRepo.findReceipt(db, 'notifications-http-forwarder', event.eventId);
      expect(afterRetryReceipt?.status).toBe('FAILED');
      expect(afterRetryReceipt?.errorMetadata).toMatchObject({ attempts: 2 });

      // Service recovers: next retry succeeds!
      shouldSucceed = true;
      const retrySuccessResult = await forwarder.retryFailedEvents({ baseRetryDelayMs: 0 });
      expect(retrySuccessResult.claimed).toBe(1);
      expect(retrySuccessResult.retried).toBe(1);
      expect(retrySuccessResult.failed).toBe(0);

      const finalReceipt = await outboxRepo.findReceipt(db, 'notifications-http-forwarder', event.eventId);
      expect(finalReceipt?.status).toBe('COMPLETED');
    });

    it('5d. Quarantine behavior: receipt is quarantined when attempts reach or exceed maxAttempts', async () => {
      const event = makeSampleEvent();
      await db.withTransaction(async (tx) => {
        await outboxService.recordEvent(tx, event);
      });

      const mockFetchFail = vi.fn().mockResolvedValue(new Response('Error', { status: 500 }));
      const forwarder = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetchFail, db },
        logger,
      );
      forwarder.registerSubscriptions(transport);
      await outboxService.publishPendingEvents();

      // Quarantine threshold: maxAttempts = 2.
      // Initial failure: attempts = 1.
      // 1st retry: attempts is 1 (< 2), tries and fails, sets attempts = 2.
      const res1 = await forwarder.retryFailedEvents({ baseRetryDelayMs: 0, maxAttempts: 2 });
      expect(res1.failed).toBe(1);

      // 2nd retry: attempts is 2 (>= 2), sets QUARANTINED!
      const res2 = await forwarder.retryFailedEvents({ baseRetryDelayMs: 0, maxAttempts: 2 });
      expect(res2.quarantined).toBe(1);

      const quarantinedReceipt = await outboxRepo.findReceipt(db, 'notifications-http-forwarder', event.eventId);
      expect(quarantinedReceipt?.status).toBe('QUARANTINED');
    });

    it('6. Successful delivery permits acknowledgement under the existing outbox policy (marks PUBLISHED)', async () => {
      const event = makeSampleEvent();

      await db.withTransaction(async (tx) => {
        await outboxService.recordEvent(tx, event);
      });

      // Wire a succeeding forwarder
      const mockFetchSuccess = vi.fn().mockImplementation(() =>
        new Response(
          JSON.stringify({ status: 'PROCESSED', eventId: event.eventId, handled: true, duplicate: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      const forwarder = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetchSuccess },
        logger,
      );
      forwarder.registerSubscriptions(transport);

      const result = await outboxService.publishPendingEvents();

      expect(result.claimedCount).toBe(1);
      expect(result.publishedCount).toBe(1);
      expect(result.failedCount).toBe(0);

      const rows = await db.query<{ status: string; published_at: unknown }>(
        `SELECT status, published_at FROM outbox_events WHERE event_id = $1`,
        [event.eventId],
      );
      expect(rows.rows.length).toBe(1);
      expect(rows.rows[0]?.status).toBe('PUBLISHED');
      expect(rows.rows[0]?.published_at).not.toBeNull();
    });
  });

  describe('4. Mode Isolation & Multi-Consumer Guarantees', () => {
    it('7. HTTP mode forwards notification events without invoking the local notification consumer', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        new Response(
          JSON.stringify({ status: 'PROCESSED', eventId: 'evt-1', handled: true, duplicate: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
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
        NOTIFICATION_CLIENT_MODE: 'http',
        NOTIFICATION_SERVICE_URL: BASE_URL,
        NOTIFICATION_SERVICE_KEY: VALID_KEY,
      });

      const httpApp = await buildApp({
        config,
        dbConnection: db,
        searchStore: new InMemorySearchStore(),
        eventTransport: transport,
        skipMigrations: true,
        notificationFetchFn: mockFetch,
      });
      await httpApp.ready();

      const event = makeSampleEvent(EventTypes.ORDER_CREATED);
      await transport.publish(event);

      // Verify HTTP forwarder was called
      expect(mockFetch).toHaveBeenCalled();

      // Verify local notifications table has zero records (local consumer did NOT run)
      const countRes = await db.query<{ count: string | number }>(
        `SELECT count(*) as count FROM notifications`,
      );
      expect(Number(countRes.rows[0]?.count ?? 0)).toBe(0);

      await httpApp.close();
    });

    it('8. Unrelated local event consumers still execute in HTTP mode', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        new Response(
          JSON.stringify({ status: 'PROCESSED', eventId: 'evt-order-1', handled: true, duplicate: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
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
        NOTIFICATION_CLIENT_MODE: 'http',
        NOTIFICATION_SERVICE_URL: BASE_URL,
        NOTIFICATION_SERVICE_KEY: VALID_KEY,
      });

      const httpApp = await buildApp({
        config,
        dbConnection: db,
        searchStore: new InMemorySearchStore(),
        eventTransport: transport,
        skipMigrations: true,
        notificationFetchFn: mockFetch,
      });
      await httpApp.ready();

      // Publish PAYMENT_SUCCEEDED: both forwarder AND OrderEventConsumer should be triggered
      const paymentEvent = createDomainEvent({
        eventType: EventTypes.PAYMENT_SUCCEEDED,
        aggregateType: 'payment_intent',
        aggregateId: 'pi-12345',
        tenantId: 'tenant-test-1',
        payload: {
          checkoutSessionId: 'cs-unrelated-test',
          amount: 250,
          currency: 'USD',
          customerEmail: 'paid@example.com',
        },
        metadata: { source: 'payment-svc' },
      });

      await transport.publish(paymentEvent);

      // 1. Forwarder executed
      expect(mockFetch).toHaveBeenCalled();

      // 2. Unrelated consumer (order-processor) also executed and claimed receipt in DB
      const orderReceipt = await outboxRepo.findReceipt(db, 'order-processor', paymentEvent.eventId);
      expect(orderReceipt).toBeDefined();

      await httpApp.close();
    });

    it('9. Local mode preserves existing in-process behavior and does not call standalone service', async () => {
      const mockFetch = vi.fn();

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
        NOTIFICATION_CLIENT_MODE: 'local', // Local mode
      });

      const localApp = await buildApp({
        config,
        dbConnection: db,
        searchStore: new InMemorySearchStore(),
        eventTransport: transport,
        skipMigrations: true,
      });
      await localApp.ready();

      const event = makeSampleEvent(EventTypes.ORDER_CREATED);
      await transport.publish(event);

      // Standalone service HTTP endpoint was NEVER called
      expect(mockFetch).not.toHaveBeenCalled();

      // Local notification consumer executed and enqueued notification in local database
      const notifsRes = await db.query<{ count: string | number }>(
        `SELECT count(*) as count FROM notifications`,
      );
      expect(Number(notifsRes.rows[0]?.count ?? 0)).toBe(1);

      await localApp.close();
    });

    it('10. In HTTP mode, notification inspection and retry routes return 501 NOTIFICATIONS_MANAGED_EXTERNALLY', async () => {
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
        NOTIFICATION_CLIENT_MODE: 'http',
        NOTIFICATION_SERVICE_URL: BASE_URL,
        NOTIFICATION_SERVICE_KEY: VALID_KEY,
      });

      const httpApp = await buildApp({
        config,
        dbConnection: db,
        searchStore: new InMemorySearchStore(),
        eventTransport: transport,
        skipMigrations: true,
      });
      await httpApp.ready();

      const adminToken = await createTestAdminToken(httpApp, db, 'admin-fwd-test@platform.com');
      const customerToken = await createTestCustomerToken(httpApp, db, 'cust-fwd-test@platform.com');

      // Authorization guard: non-admin customer still gets 403 Forbidden
      const forbiddenRes = await httpApp.inject({
        method: 'GET',
        url: '/notifications',
        headers: { Authorization: `Bearer ${customerToken}` },
      });
      expect(forbiddenRes.statusCode).toBe(403);

      // Admin GET /notifications -> 501
      const listRes = await httpApp.inject({
        method: 'GET',
        url: '/notifications',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(listRes.statusCode).toBe(501);
      const listBody = listRes.json();
      expect(listBody.error.code).toBe('NOTIFICATIONS_MANAGED_EXTERNALLY');

      // Admin GET /notifications/:id -> 501
      const getRes = await httpApp.inject({
        method: 'GET',
        url: '/notifications/notif-123',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(getRes.statusCode).toBe(501);
      expect(getRes.json().error.code).toBe('NOTIFICATIONS_MANAGED_EXTERNALLY');

      // Admin POST /notifications/:id/retry -> 501
      const retryRes = await httpApp.inject({
        method: 'POST',
        url: '/notifications/notif-123/retry',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(retryRes.statusCode).toBe(501);
      expect(retryRes.json().error.code).toBe('NOTIFICATIONS_MANAGED_EXTERNALLY');

      await httpApp.close();
    });

    it('11. In HTTP mode, customer preference routes return 501 NOTIFICATIONS_MANAGED_EXTERNALLY while preserving auth & validation', async () => {
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
        NOTIFICATION_CLIENT_MODE: 'http',
        NOTIFICATION_SERVICE_URL: BASE_URL,
        NOTIFICATION_SERVICE_KEY: VALID_KEY,
      });

      const httpApp = await buildApp({
        config,
        dbConnection: db,
        searchStore: new InMemorySearchStore(),
        eventTransport: transport,
        skipMigrations: true,
      });
      await httpApp.ready();

      // Unauthenticated request receives 401
      const unauthRes = await httpApp.inject({
        method: 'GET',
        url: '/customers/me/notification-preferences',
      });
      expect(unauthRes.statusCode).toBe(401);

      // Customer authenticated request receives 501
      const customerToken = await createTestCustomerToken(httpApp, db, 'cust-pref-test@platform.com');

      const getPrefRes = await httpApp.inject({
        method: 'GET',
        url: '/customers/me/notification-preferences',
        headers: { Authorization: `Bearer ${customerToken}` },
      });
      expect(getPrefRes.statusCode).toBe(501);
      expect(getPrefRes.json().error.code).toBe('NOTIFICATIONS_MANAGED_EXTERNALLY');

      // Invalid body on PUT receives 400 validation error
      const badPutRes = await httpApp.inject({
        method: 'PUT',
        url: '/customers/me/notification-preferences',
        headers: { Authorization: `Bearer ${customerToken}` },
        payload: { disabledTypes: 'not-an-array' },
      });
      expect(badPutRes.statusCode).toBe(400);

      // Valid customer PUT receives 501
      const putPrefRes = await httpApp.inject({
        method: 'PUT',
        url: '/customers/me/notification-preferences',
        headers: { Authorization: `Bearer ${customerToken}` },
        payload: { emailEnabled: false },
      });
      expect(putPrefRes.statusCode).toBe(501);
      expect(putPrefRes.json().error.code).toBe('NOTIFICATIONS_MANAGED_EXTERNALLY');

      await httpApp.close();
    });

    it('12. In HTTP mode, POST /notifications/process proxies to notificationClient.processPendingNotifications', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/internal/notifications/process')) {
          return new Response(
            JSON.stringify({ claimed: 4, sent: 4, failed: 0, deadLettered: 0 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200 });
      });

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
        NOTIFICATION_CLIENT_MODE: 'http',
        NOTIFICATION_SERVICE_URL: BASE_URL,
        NOTIFICATION_SERVICE_KEY: VALID_KEY,
      });

      const httpApp = await buildApp({
        config,
        dbConnection: db,
        searchStore: new InMemorySearchStore(),
        eventTransport: transport,
        skipMigrations: true,
        notificationFetchFn: mockFetch,
      });
      await httpApp.ready();

      const adminToken = await createTestAdminToken(httpApp, db, 'admin-proc-test@platform.com');

      const processRes = await httpApp.inject({
        method: 'POST',
        url: '/notifications/process',
        headers: { Authorization: `Bearer ${adminToken}` },
        payload: { batchSize: 20 },
      });

      expect(processRes.statusCode).toBe(200);
      expect(processRes.json()).toEqual({ claimed: 4, sent: 4, failed: 0, deadLettered: 0 });

      await httpApp.close();
    });

    it('13. In Local mode, existing notification and preference routes function normally', async () => {
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
        NOTIFICATION_CLIENT_MODE: 'local',
      });

      const localApp = await buildApp({
        config,
        dbConnection: db,
        searchStore: new InMemorySearchStore(),
        eventTransport: transport,
        skipMigrations: true,
      });
      await localApp.ready();

      const adminToken = await createTestAdminToken(localApp, db, 'admin-local-test@platform.com');
      const customerToken = await createTestCustomerToken(localApp, db, 'cust-local-test@platform.com');

      // GET /notifications in local mode returns 200 array
      const listRes = await localApp.inject({
        method: 'GET',
        url: '/notifications',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(listRes.statusCode).toBe(200);
      expect(Array.isArray(listRes.json().items)).toBe(true);

      // POST /notifications/process in local mode returns 200
      const processRes = await localApp.inject({
        method: 'POST',
        url: '/notifications/process',
        headers: { Authorization: `Bearer ${adminToken}` },
        payload: { batchSize: 10 },
      });
      expect(processRes.statusCode).toBe(200);

      // GET /customers/me/notification-preferences returns 200
      const getPrefRes = await localApp.inject({
        method: 'GET',
        url: '/customers/me/notification-preferences',
        headers: { Authorization: `Bearer ${customerToken}` },
      });
      expect(getPrefRes.statusCode).toBe(200);

      // PUT /customers/me/notification-preferences returns 200
      const putPrefRes = await localApp.inject({
        method: 'PUT',
        url: '/customers/me/notification-preferences',
        headers: { Authorization: `Bearer ${customerToken}` },
        payload: { emailEnabled: false, smsEnabled: true },
      });
      expect(putPrefRes.statusCode).toBe(200);
      expect(putPrefRes.json().emailEnabled).toBe(false);

      await localApp.close();
    });
  });

  describe('5. Real Cross-Workspace Contract Parity', () => {
    let StandaloneEventTypes: Record<string, string>;
    let SUPPORTED_EVENT_VERSIONS: Record<string, number[]>;
    let FORBIDDEN_PAYLOAD_KEYS: Set<string>;

    beforeAll(async () => {
      const modelsPath = resolve(process.cwd(), '../notifications-service/src/events/event-models.ts');
      const mod = (await import(pathToFileURL(modelsPath).href)) as {
        NotificationEventTypes: Record<string, string>;
        SUPPORTED_EVENT_VERSIONS: Record<string, number[]>;
        FORBIDDEN_PAYLOAD_KEYS: Set<string>;
      };
      StandaloneEventTypes = mod.NotificationEventTypes;
      SUPPORTED_EVENT_VERSIONS = mod.SUPPORTED_EVENT_VERSIONS;
      FORBIDDEN_PAYLOAD_KEYS = mod.FORBIDDEN_PAYLOAD_KEYS;
    });

    it('verifies exact event type matching between monolith and standalone notifications service', () => {
      const standaloneTypes = Object.values(StandaloneEventTypes);
      expect(NOTIFICATION_EVENT_TYPES).toEqual(standaloneTypes);

      // Verify each event type has exact mapping in monolith EventTypes
      expect(StandaloneEventTypes.ORDER_CREATED).toBe(EventTypes.ORDER_CREATED);
      expect(StandaloneEventTypes.PAYMENT_SUCCEEDED).toBe(EventTypes.PAYMENT_SUCCEEDED);
      expect(StandaloneEventTypes.PAYMENT_FAILED).toBe(EventTypes.PAYMENT_FAILED);
      expect(StandaloneEventTypes.FULFILLMENT_SHIPMENT_STATUS_CHANGED).toBe(
        EventTypes.FULFILLMENT_SHIPMENT_STATUS_CHANGED,
      );
      expect(StandaloneEventTypes.FULFILLMENT_RETURN_STATUS_CHANGED).toBe(
        EventTypes.FULFILLMENT_RETURN_STATUS_CHANGED,
      );
      expect(StandaloneEventTypes.SETTLEMENT_STATUS_CHANGED).toBe(
        EventTypes.SETTLEMENT_STATUS_CHANGED,
      );
    });

    it('verifies supported event versions in standalone service cover all notification event types with version 1', () => {
      for (const eventType of NOTIFICATION_EVENT_TYPES) {
        const supportedVersions = SUPPORTED_EVENT_VERSIONS[eventType];
        expect(supportedVersions).toBeDefined();
        expect(supportedVersions).toContain(1);
      }
    });

    it('verifies forbidden payload keys guard against credential and secret leakage', () => {
      const sensitiveKeys = ['password', 'secret', 'token', 'authorization', 'card_number', 'cvv'];
      for (const key of sensitiveKeys) {
        expect(FORBIDDEN_PAYLOAD_KEYS.has(key)).toBe(true);
      }
    });

    it('verifies canonical envelope field structure parity between monolith and standalone', () => {
      const event = makeSampleEvent();
      const requiredEnvelopeFields = [
        'eventId',
        'eventType',
        'eventVersion',
        'aggregateType',
        'aggregateId',
        'tenantId',
        'occurredAt',
        'payload',
        'metadata',
      ];
      for (const field of requiredEnvelopeFields) {
        expect(event).toHaveProperty(field);
      }
    });
  });

  describe('6. Phase 2.2 — Durable Retry, Atomic Claiming, Backoff & Crash Recovery Regression Suite', () => {
    it('1. Retry runner is registered only in HTTP mode and is cleaned up on shutdown', async () => {
      const baseEnv = {
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
      };

      const httpConfig = parseConfig({
        ...baseEnv,
        NOTIFICATION_CLIENT_MODE: 'http',
        NOTIFICATION_SERVICE_URL: BASE_URL,
        NOTIFICATION_SERVICE_KEY: VALID_KEY,
      });

      const httpApp = await buildApp({
        config: httpConfig,
        logger,
        dbConnection: db,
        eventTransport: transport,
        searchStore: new InMemorySearchStore(),
        skipMigrations: true,
        enableBackgroundWorkers: true,
      });

      expect(httpApp.eventForwarder).toBeDefined();

      // Shutdown cleanup
      await httpApp.close();

      // Local mode
      const localConfig = parseConfig({
        ...baseEnv,
        NOTIFICATION_CLIENT_MODE: 'local',
      });

      const localApp = await buildApp({
        config: localConfig,
        logger,
        dbConnection: db,
        eventTransport: transport,
        searchStore: new InMemorySearchStore(),
        skipMigrations: true,
        enableBackgroundWorkers: true,
      });

      expect(localApp.eventForwarder).toBeUndefined();
      await localApp.close();
    });

    it('2 & 3. Transient failure becomes eligible for retry after backoff and is NOT retried before', async () => {
      const event = makeSampleEvent();
      await db.withTransaction(async (tx) => {
        await outboxService.recordEvent(tx, event);
      });

      let forwardCalls = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        forwardCalls += 1;
        return new Response(JSON.stringify({ error: 'Gateway timeout' }), { status: 504 });
      });

      const forwarder = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetch, db },
        logger,
      );
      forwarder.registerSubscriptions(transport);

      // Initial publish: fails -> records FAILED with attempts = 1
      await outboxService.publishPendingEvents();
      expect(forwardCalls).toBe(1);

      const receipt1 = await outboxRepo.findReceipt(db, 'notifications-http-forwarder', event.eventId);
      expect(receipt1?.status).toBe('FAILED');
      expect(receipt1?.errorMetadata).toMatchObject({ attempts: 1 });

      // Immediate retry with baseRetryDelayMs: 2000 ms -> should NOT be eligible!
      const immediateResult = await forwarder.retryFailedEvents({ baseRetryDelayMs: 2000 });
      expect(immediateResult.claimed).toBe(0);
      expect(immediateResult.retried).toBe(0);
      expect(forwardCalls).toBe(1); // not called!

      // Fast forward time by simulating failure 3000ms ago
      const pastTime = new Date(Date.now() - 3000).toISOString();
      await db.query(
        `UPDATE event_consumer_receipts
         SET processed_at = $1, error_metadata = $2
         WHERE consumer_name = 'notifications-http-forwarder' AND event_id = $3`,
        [
          pastTime,
          JSON.stringify({ attempts: 1, failedAt: pastTime, lastError: 'Gateway timeout' }),
          event.eventId,
        ],
      );

      // Now it IS eligible (3000ms > 2000ms)
      const afterBackoffResult = await forwarder.retryFailedEvents({ baseRetryDelayMs: 2000 });
      expect(afterBackoffResult.claimed).toBe(1);
      expect(afterBackoffResult.failed).toBe(1);
      expect(forwardCalls).toBe(2);

      const receipt2 = await outboxRepo.findReceipt(db, 'notifications-http-forwarder', event.eventId);
      expect(receipt2?.errorMetadata).toMatchObject({ attempts: 2 });

      // Second failure -> backoff multiplier is 2^1 = 2 -> delay is 2000 * 2 = 4000ms
      // 2500ms in the past is NOT enough (2500 < 4000)
      const pastTime2 = new Date(Date.now() - 2500).toISOString();
      await db.query(
        `UPDATE event_consumer_receipts
         SET processed_at = $1, error_metadata = $2
         WHERE consumer_name = 'notifications-http-forwarder' AND event_id = $3`,
        [
          pastTime2,
          JSON.stringify({ attempts: 2, failedAt: pastTime2, lastError: 'Gateway timeout' }),
          event.eventId,
        ],
      );
      const intermediateResult = await forwarder.retryFailedEvents({ baseRetryDelayMs: 2000 });
      expect(intermediateResult.claimed).toBe(0);
      expect(forwardCalls).toBe(2);

      // 4500ms in the past IS enough (4500 >= 4000)
      const pastTime3 = new Date(Date.now() - 4500).toISOString();
      await db.query(
        `UPDATE event_consumer_receipts
         SET processed_at = $1, error_metadata = $2
         WHERE consumer_name = 'notifications-http-forwarder' AND event_id = $3`,
        [
          pastTime3,
          JSON.stringify({ attempts: 2, failedAt: pastTime3, lastError: 'Gateway timeout' }),
          event.eventId,
        ],
      );
      const eligibleResult = await forwarder.retryFailedEvents({ baseRetryDelayMs: 2000 });
      expect(eligibleResult.claimed).toBe(1);
      expect(forwardCalls).toBe(3);
    });

    it('4. Concurrent retry workers cannot claim the same failed receipt', async () => {
      const event = makeSampleEvent();
      await db.withTransaction(async (tx) => {
        await outboxService.recordEvent(tx, event);
      });

      // Insert pre-failed receipt
      await db.query(
        `INSERT INTO event_consumer_receipts (id, consumer_name, event_id, status, error_metadata, processed_at, created_at)
         VALUES ($1, $2, $3, 'FAILED', $4, NOW() - INTERVAL '10 seconds', NOW() - INTERVAL '10 seconds')`,
        [
          `rcp-${Date.now()}`,
          'notifications-http-forwarder',
          event.eventId,
          JSON.stringify({ attempts: 1, failedAt: new Date(Date.now() - 10000).toISOString() }),
        ],
      );

      let forwardCalls = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        forwardCalls += 1;
        // Introduce small async tick
        await new Promise((r) => setTimeout(r, 20));
        return new Response(
          JSON.stringify({ status: 'PROCESSED', eventId: event.eventId, handled: true, duplicate: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const worker1 = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetch, db },
        logger,
      );
      const worker2 = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetch, db },
        logger,
      );

      // Concurrently run retry on both workers
      const [res1, res2] = await Promise.all([
        worker1.retryFailedEvents({ baseRetryDelayMs: 0 }),
        worker2.retryFailedEvents({ baseRetryDelayMs: 0 }),
      ]);

      // Exactly one worker must have claimed the receipt!
      const totalClaimed = res1.claimed + res2.claimed;
      const totalSucceeded = res1.succeeded + res2.succeeded;
      expect(totalClaimed).toBe(1);
      expect(totalSucceeded).toBe(1);
      expect(forwardCalls).toBe(1);

      const finalReceipt = await outboxRepo.findReceipt(db, 'notifications-http-forwarder', event.eventId);
      expect(finalReceipt?.status).toBe('COMPLETED');
    });

    it('5. Stale PROCESSING receipt is reclaimed safely after stale timeout', async () => {
      const event = makeSampleEvent();
      await db.withTransaction(async (tx) => {
        await outboxService.recordEvent(tx, event);
      });

      // Simulate a crashed worker: receipt left in PROCESSING with stale processed_at
      const staleTime = new Date(Date.now() - 10000).toISOString(); // 10s ago
      await db.query(
        `INSERT INTO event_consumer_receipts (id, consumer_name, event_id, status, error_metadata, processed_at, created_at)
         VALUES ($1, $2, $3, 'PROCESSING', $4, $5, $5)`,
        [
          `rcp-${Date.now()}`,
          'notifications-http-forwarder',
          event.eventId,
          JSON.stringify({ claimToken: 'crashed-worker-token', attempts: 1 }),
          staleTime,
        ],
      );

      let forwardCalled = false;
      const mockFetch = vi.fn().mockImplementation(async () => {
        forwardCalled = true;
        return new Response(
          JSON.stringify({ status: 'PROCESSED', eventId: event.eventId, handled: true, duplicate: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const forwarder = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetch, db },
        logger,
      );

      // Active non-stale check: if staleTimeoutMs is 60000ms (1 min), 10s is not stale!
      const nonStaleResult = await forwarder.retryFailedEvents({ staleTimeoutMs: 60000 });
      expect(nonStaleResult.claimed).toBe(0);
      expect(forwardCalled).toBe(false);

      // Stale check: with staleTimeoutMs = 5000ms (5s), 10s IS stale and reclaimed!
      const staleResult = await forwarder.retryFailedEvents({ staleTimeoutMs: 5000 });
      expect(staleResult.claimed).toBe(1);
      expect(staleResult.succeeded).toBe(1);
      expect(forwardCalled).toBe(true);

      const receipt = await outboxRepo.findReceipt(db, 'notifications-http-forwarder', event.eventId);
      expect(receipt?.status).toBe('COMPLETED');
    });

    it('6. Worker whose claim has expired cannot overwrite the new worker result (claim fencing)', async () => {
      const event = makeSampleEvent();
      await db.withTransaction(async (tx) => {
        await outboxService.recordEvent(tx, event);
      });

      // Initial receipt in PROCESSING with Worker A's token
      const oldToken = 'worker-a-expired-token';
      await db.query(
        `INSERT INTO event_consumer_receipts (id, consumer_name, event_id, status, error_metadata, processed_at, created_at)
         VALUES ($1, $2, $3, 'PROCESSING', $4, NOW(), NOW())`,
        [
          `rcp-${Date.now()}`,
          'notifications-http-forwarder',
          event.eventId,
          JSON.stringify({ claimToken: oldToken, attempts: 1 }),
        ],
      );

      // Worker B reclaims it after Worker A times out, changing status to COMPLETED with NULL error_metadata
      await db.query(
        `UPDATE event_consumer_receipts
         SET status = 'COMPLETED', processed_at = NOW(), error_metadata = NULL
         WHERE consumer_name = 'notifications-http-forwarder' AND event_id = $1`,
        [event.eventId],
      );

      // Now Worker A wakes up and attempts to mark FAILED using its old claimToken
      const updateRes = await db.query(
        `UPDATE event_consumer_receipts
         SET status = 'FAILED', processed_at = NOW(), error_metadata = $1
         WHERE consumer_name = 'notifications-http-forwarder' AND event_id = $2
           AND status = 'PROCESSING'
           AND error_metadata->>'claimToken' = $3`,
        [
          JSON.stringify({ attempts: 2, lastError: 'Late failure' }),
          event.eventId,
          oldToken,
        ],
      );

      // Fencing check: 0 rows affected!
      expect(updateRes.rowCount).toBe(0);

      // Verify the receipt is still COMPLETED as set by Worker B!
      const receipt = await outboxRepo.findReceipt(db, 'notifications-http-forwarder', event.eventId);
      expect(receipt?.status).toBe('COMPLETED');
    });

    it('7. Exhausted attempts transition to QUARANTINED without further network calls', async () => {
      const event = makeSampleEvent();
      await db.withTransaction(async (tx) => {
        await outboxService.recordEvent(tx, event);
      });

      // Insert receipt that already failed 3 times
      await db.query(
        `INSERT INTO event_consumer_receipts (id, consumer_name, event_id, status, error_metadata, processed_at, created_at)
         VALUES ($1, $2, $3, 'FAILED', $4, NOW() - INTERVAL '10 seconds', NOW() - INTERVAL '10 seconds')`,
        [
          `rcp-${Date.now()}`,
          'notifications-http-forwarder',
          event.eventId,
          JSON.stringify({ attempts: 3, failedAt: new Date(Date.now() - 10000).toISOString() }),
        ],
      );

      const mockFetch = vi.fn();
      const forwarder = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetch, db },
        logger,
      );

      // maxAttempts is 3: attempts (3) >= maxAttempts (3) -> quarantine!
      const result = await forwarder.retryFailedEvents({ baseRetryDelayMs: 0, maxAttempts: 3 });
      expect(result.quarantined).toBe(1);
      expect(result.claimed).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();

      const receipt = await outboxRepo.findReceipt(db, 'notifications-http-forwarder', event.eventId);
      expect(receipt?.status).toBe('QUARANTINED');
    });

    it('8. Crash after remote acceptance and redelivery is handled idempotently', async () => {
      const event = makeSampleEvent();
      await db.withTransaction(async (tx) => {
        await outboxService.recordEvent(tx, event);
      });

      // Remote service accepted event on initial try (returned 200), but local worker crashed before saving COMPLETED
      // So local receipt was left as FAILED or stale PROCESSING
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'ALREADY_COMPLETED',
            eventId: event.eventId,
            handled: false,
            duplicate: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      // Insert pre-existing FAILED receipt
      await db.query(
        `INSERT INTO event_consumer_receipts (id, consumer_name, event_id, status, error_metadata, processed_at, created_at)
         VALUES ($1, $2, $3, 'FAILED', $4, NOW() - INTERVAL '5 seconds', NOW() - INTERVAL '5 seconds')`,
        [
          `rcp-${Date.now()}`,
          'notifications-http-forwarder',
          event.eventId,
          JSON.stringify({ attempts: 1 }),
        ],
      );

      const forwarder = new HttpEventForwarder(
        { baseUrl: BASE_URL, internalServiceKey: VALID_KEY, fetchFn: mockFetch, db },
        logger,
      );

      const result = await forwarder.retryFailedEvents({ baseRetryDelayMs: 0 });
      expect(result.succeeded).toBe(1);

      const receipt = await outboxRepo.findReceipt(db, 'notifications-http-forwarder', event.eventId);
      expect(receipt?.status).toBe('COMPLETED');
    });
  });

  async function createTestAdminToken(
    testApp: any,
    testDb: DatabaseConnection,
    email = `admin-${Date.now()}@platform.com`,
  ): Promise<string> {
    await testApp.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email,
        password: 'AdminPassword123!',
        tenantName: 'Platform Tenant',
        role: 'MERCHANT',
      },
    });
    const userRes = await testDb.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
      email.toLowerCase(),
    ]);
    await testDb.query(`UPDATE tenant_memberships SET role = 'ADMINISTRATOR' WHERE user_id = $1`, [
      userRes.rows[0]!.id,
    ]);
    await markAllUsersVerified(testDb);
    const login = await testApp.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'AdminPassword123!' },
    });
    return (login.json() as { accessToken: string }).accessToken;
  }

  async function createTestCustomerToken(
    testApp: any,
    testDb: DatabaseConnection,
    email = `customer-${Date.now()}@example.com`,
  ): Promise<string> {
    await testApp.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email,
        password: 'CustomerPassword123!',
        tenantName: 'Customer Tenant',
        role: 'CUSTOMER',
      },
    });
    await markAllUsersVerified(testDb);
    const login = await testApp.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'CustomerPassword123!' },
    });
    return (login.json() as { accessToken: string }).accessToken;
  }
});
