import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config/index.js';
import { createMigratedTestDatabase } from './helpers/test-db.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';
import {
  type DomainEvent,
  EventTypes,
  InMemoryEventTransport,
  OutboxRepository,
  BaseEventConsumer,
  isUniqueConstraintViolation,
  ConsumerRetryRunner,
} from '../src/modules/events/index.js';
import { JsonLogger } from '../src/observability/logger.js';
import { OrderEventConsumer } from '../src/modules/orders/internal/order-consumer.js';
import type { OrderService } from '../src/modules/orders/internal/order-service.js';
import { ValidationError } from '../src/errors/app-error.js';

describe('Phase 3.2: Shared Event Consumer Reliability Correction', () => {
  let db: DatabaseConnection;
  let transport: InMemoryEventTransport;
  let outboxRepo: OutboxRepository;
  let logger: JsonLogger;

  beforeEach(async () => {
    db = await createMigratedTestDatabase();
    transport = new InMemoryEventTransport();
    outboxRepo = new OutboxRepository();
    logger = new JsonLogger({ serviceName: 'test-consumer-reliability', level: 'error' });
  });

  afterEach(async () => {
    if (db) await db.close();
  });

  function createTestEvent(eventType: string = EventTypes.ORDER_CREATED): DomainEvent {
    const eventId = `evt-${randomUUID()}`;
    return {
      eventId,
      eventType,
      eventVersion: 1,
      aggregateType: 'order',
      aggregateId: `agg-${randomUUID()}`,
      tenantId: 'tenant-test-1',
      occurredAt: new Date().toISOString(),
      payload: { foo: 'bar' },
      metadata: {
        correlationId: `corr-${randomUUID()}`,
      },
    };
  }

  async function persistOutboxEvent(event: DomainEvent): Promise<void> {
    await db.query(
      `INSERT INTO outbox_events (
        event_id, event_type, event_version, aggregate_type, aggregate_id,
        tenant_id, occurred_at, payload, metadata, status, attempt_count,
        available_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PUBLISHED', 1, NOW(), NOW(), NOW())`,
      [
        event.eventId,
        event.eventType,
        event.eventVersion,
        event.aggregateType,
        event.aggregateId,
        event.tenantId,
        event.occurredAt,
        JSON.stringify(event.payload),
        JSON.stringify(event.metadata),
      ],
    );
  }

  // --- 1. Durable retry of handler failure without manual receipt deletion ---
  it('1. Handler failure is durably retried without manual receipt deletion', async () => {
    let attempts = 0;
    let shouldFail = true;

    class ResilientTestConsumer extends BaseEventConsumer {
      constructor() {
        super('resilient-consumer', db, outboxRepo, transport, logger, {
          baseRetryDelayMs: 0,
        });
      }

      registerSubscriptions(): void {
        this.transport.subscribe(EventTypes.ORDER_CREATED, async (e) => {
          await this.process(e);
        });
      }

      protected async handleEvent(_event: DomainEvent): Promise<void> {
        attempts++;
        if (shouldFail) {
          throw new Error('Temporary downstream outage');
        }
      }
    }

    const consumer = new ResilientTestConsumer();
    consumer.registerSubscriptions();

    const event = createTestEvent();
    await persistOutboxEvent(event);

    // Initial delivery fails
    const initialResult = await consumer.process(event);
    expect(initialResult.handled).toBe(false);
    expect(initialResult.error).toBe('Temporary downstream outage');
    expect(attempts).toBe(1);

    // Verify receipt in DB is FAILED
    const receiptAfterFailure = await outboxRepo.findReceipt(db, 'resilient-consumer', event.eventId);
    expect(receiptAfterFailure?.status).toBe('FAILED');
    expect(receiptAfterFailure?.errorMetadata).toMatchObject({
      attempts: 1,
      lastError: 'Temporary downstream outage',
    });

    // Fix condition: downstream is now healthy
    shouldFail = false;

    // Retry WITHOUT manually deleting the receipt!
    const retryResult = await consumer.retryFailedEvents({ baseRetryDelayMs: 0 });
    expect(retryResult.claimed).toBe(1);
    expect(retryResult.succeeded).toBe(1);
    expect(retryResult.failed).toBe(0);
    expect(attempts).toBe(2);

    // Verify receipt in DB is COMPLETED
    const receiptAfterRetry = await outboxRepo.findReceipt(db, 'resilient-consumer', event.eventId);
    expect(receiptAfterRetry?.status).toBe('COMPLETED');
    expect(receiptAfterRetry?.errorMetadata).toBeNull();
  });

  // --- 2. Receipt-insertion infrastructure errors are propagated and not classified as duplicates ---
  it('2. Receipt-insertion infrastructure errors are propagated and are not classified as duplicates', async () => {
    class FailingDbConsumer extends BaseEventConsumer {
      constructor() {
        super('infra-fail-consumer', db, outboxRepo, transport, logger);
      }
      registerSubscriptions(): void {}
      protected async handleEvent(): Promise<void> {}
    }

    const consumer = new FailingDbConsumer();
    const event = createTestEvent();

    // Mock db.query to throw a non-23505 DB error on INSERT
    const originalQuery = db.query.bind(db);
    const querySpy = vi.spyOn(db, 'query').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO event_consumer_receipts')) {
        const error = new Error('Connection terminated unexpectedly');
        (error as { code?: string }).code = '08006'; // Connection failure, NOT 23505
        throw error;
      }
      return originalQuery(sql, params);
    });

    try {
      await expect(consumer.process(event)).rejects.toThrow('Connection terminated unexpectedly');
    } finally {
      querySpy.mockRestore();
    }

    // Verify helper isUniqueConstraintViolation correctly identifies PG errors
    expect(isUniqueConstraintViolation({ code: '23505' })).toBe(true);
    expect(isUniqueConstraintViolation(new Error('duplicate key value violates unique constraint "uq_consumer_event_receipt"'))).toBe(true);
    expect(isUniqueConstraintViolation({ code: '08006' })).toBe(false);
    expect(isUniqueConstraintViolation(new Error('Connection terminated unexpectedly'))).toBe(false);
  });

  // --- 3. Concurrent duplicate delivery does not execute the same consumer concurrently ---
  it('3. Concurrent duplicate delivery does not execute the same consumer concurrently', async () => {
    let executionCount = 0;

    class ConcurrencyGuardConsumer extends BaseEventConsumer {
      constructor() {
        super('concurrency-consumer', db, outboxRepo, transport, logger);
      }
      registerSubscriptions(): void {}
      protected async handleEvent(): Promise<void> {
        executionCount++;
      }
    }

    const consumer = new ConcurrencyGuardConsumer();
    const event = createTestEvent();

    // Worker 1 inserts receipt with status PROCESSING and fresh timestamp (simulating active execution)
    await db.query(
      `INSERT INTO event_consumer_receipts (
        id, consumer_name, event_id, status, error_metadata, processed_at, created_at
      ) VALUES ($1, $2, $3, 'PROCESSING', $4, NOW(), NOW())`,
      [
        randomUUID(),
        'concurrency-consumer',
        event.eventId,
        JSON.stringify({ claimToken: 'worker-1-token', attempts: 1 }),
      ],
    );

    // Worker 2 calls process() on the same event concurrently
    const resultWorker2 = await consumer.process(event);

    // Worker 2 must recognize active worker and deduplicate without executing handler
    expect(resultWorker2.handled).toBe(false);
    expect(resultWorker2.duplicate).toBe(true);
    expect(executionCount).toBe(0);
  });

  // --- 4. A stale PROCESSING receipt can be reclaimed safely ---
  it('4. A stale PROCESSING receipt can be reclaimed safely', async () => {
    let executionCount = 0;

    class StaleReclaimConsumer extends BaseEventConsumer {
      constructor() {
        super('stale-reclaim-consumer', db, outboxRepo, transport, logger, {
          staleTimeoutMs: 1000,
        });
      }
      registerSubscriptions(): void {}
      protected async handleEvent(): Promise<void> {
        executionCount++;
      }
    }

    const consumer = new StaleReclaimConsumer();
    const event = createTestEvent();
    await persistOutboxEvent(event);

    // Simulate crashed worker: receipt left in PROCESSING 5 seconds ago (stale > 1000ms)
    const staleTime = new Date(Date.now() - 5000).toISOString();
    await db.query(
      `INSERT INTO event_consumer_receipts (
        id, consumer_name, event_id, status, error_metadata, processed_at, created_at
      ) VALUES ($1, $2, $3, 'PROCESSING', $4, $5, $5)`,
      [
        randomUUID(),
        'stale-reclaim-consumer',
        event.eventId,
        JSON.stringify({ claimToken: 'crashed-worker-token', attempts: 1 }),
        staleTime,
      ],
    );

    // Next worker calls process() or retryFailedEvents()
    const reclaimResult = await consumer.process(event);
    expect(reclaimResult.handled).toBe(true);
    expect(reclaimResult.duplicate).toBe(false);
    expect(executionCount).toBe(1);

    const receipt = await outboxRepo.findReceipt(db, 'stale-reclaim-consumer', event.eventId);
    expect(receipt?.status).toBe('COMPLETED');
  });

  // --- 5. A stale worker cannot overwrite the result of a newer claim ---
  it('5. A stale worker cannot overwrite the result of a newer claim', async () => {
    const event = createTestEvent();
    const consumerName = 'fencing-consumer';

    // 1. Worker A claims receipt with token A
    const tokenA = 'worker-A-token';
    const staleTime = new Date(Date.now() - 10000).toISOString();
    await db.query(
      `INSERT INTO event_consumer_receipts (
        id, consumer_name, event_id, status, error_metadata, processed_at, created_at
      ) VALUES ($1, $2, $3, 'PROCESSING', $4, $5, $5)`,
      [
        randomUUID(),
        consumerName,
        event.eventId,
        JSON.stringify({ claimToken: tokenA, attempts: 1 }),
        staleTime,
      ],
    );

    // 2. Worker B reclaims receipt with token B because Worker A's lease expired
    const tokenB = 'worker-B-token';
    const reclaimRes = await db.query(
      `UPDATE event_consumer_receipts
       SET status = 'PROCESSING', processed_at = NOW(), error_metadata = $3
       WHERE consumer_name = $1 AND event_id = $2
         AND status = 'PROCESSING' AND processed_at <= $4`,
      [
        consumerName,
        event.eventId,
        JSON.stringify({ claimToken: tokenB, attempts: 2 }),
        new Date(Date.now() - 5000).toISOString(),
      ],
    );
    expect(reclaimRes.rowCount).toBe(1);

    // 3. Worker A wakes up and attempts to mark COMPLETED using token A
    const staleWorkerCompleteRes = await db.query(
      `UPDATE event_consumer_receipts
       SET status = 'COMPLETED', processed_at = NOW(), error_metadata = NULL
       WHERE consumer_name = $1 AND event_id = $2
         AND status = 'PROCESSING'
         AND error_metadata->>'claimToken' = $3`,
      [consumerName, event.eventId, tokenA],
    );

    // Must affect 0 rows because token A has been superseded!
    expect(staleWorkerCompleteRes.rowCount).toBe(0);

    // 4. Verify receipt is still owned by Worker B with attempts=2
    const currentReceipt = await outboxRepo.findReceipt(db, consumerName, event.eventId);
    expect(currentReceipt?.status).toBe('PROCESSING');
    expect(currentReceipt?.errorMetadata).toMatchObject({
      claimToken: tokenB,
      attempts: 2,
    });

    // 5. Worker B successfully completes with token B
    const workerBCompleteRes = await db.query(
      `UPDATE event_consumer_receipts
       SET status = 'COMPLETED', processed_at = NOW(), error_metadata = NULL
       WHERE consumer_name = $1 AND event_id = $2
         AND status = 'PROCESSING'
         AND error_metadata->>'claimToken' = $3`,
      [consumerName, event.eventId, tokenB],
    );
    expect(workerBCompleteRes.rowCount).toBe(1);

    const finalReceipt = await outboxRepo.findReceipt(db, consumerName, event.eventId);
    expect(finalReceipt?.status).toBe('COMPLETED');
  });

  // --- 6. A completed sibling consumer is not re-executed when another consumer retries ---
  it('6. A completed sibling consumer is not re-executed when another consumer retries', async () => {
    let siblingExecCount = 0;
    let failingExecCount = 0;
    let shouldFailingPass = false;

    class SiblingConsumer extends BaseEventConsumer {
      constructor() {
        super('sibling-consumer', db, outboxRepo, transport, logger);
      }
      registerSubscriptions(): void {
        this.transport.subscribe(EventTypes.ORDER_CREATED, async (e) => {
          await this.process(e);
        });
      }
      protected async handleEvent(): Promise<void> {
        siblingExecCount++;
      }
    }

    class FailingConsumer extends BaseEventConsumer {
      constructor() {
        super('failing-consumer', db, outboxRepo, transport, logger, {
          baseRetryDelayMs: 0,
        });
      }
      registerSubscriptions(): void {
        this.transport.subscribe(EventTypes.ORDER_CREATED, async (e) => {
          await this.process(e);
        });
      }
      protected async handleEvent(): Promise<void> {
        failingExecCount++;
        if (!shouldFailingPass) {
          throw new Error('Failing consumer initial error');
        }
      }
    }

    const sibling = new SiblingConsumer();
    const failing = new FailingConsumer();
    sibling.registerSubscriptions();
    failing.registerSubscriptions();

    const event = createTestEvent();
    await persistOutboxEvent(event);

    // Initial dispatch to transport: both invoked
    await transport.publish(event);

    expect(siblingExecCount).toBe(1);
    expect(failingExecCount).toBe(1);

    const siblingReceipt = await outboxRepo.findReceipt(db, 'sibling-consumer', event.eventId);
    const failingReceipt = await outboxRepo.findReceipt(db, 'failing-consumer', event.eventId);
    expect(siblingReceipt?.status).toBe('COMPLETED');
    expect(failingReceipt?.status).toBe('FAILED');

    // Failing consumer retries
    shouldFailingPass = true;
    const retryResult = await failing.retryFailedEvents({ baseRetryDelayMs: 0 });
    expect(retryResult.succeeded).toBe(1);
    expect(failingExecCount).toBe(2);

    // Sibling consumer was NEVER re-executed!
    expect(siblingExecCount).toBe(1);

    // Even if transport re-dispatches, sibling deduplicates safely
    await transport.publish(event);
    expect(siblingExecCount).toBe(1);
  });

  // --- 7. A critical order-creation failure is recoverable and idempotent ---
  it('7. A critical order-creation failure is recoverable and idempotent', async () => {
    let createOrderCalls = 0;
    let shouldOrderServiceFail = true;

    const mockOrderService = {
      createOrderFromCheckout: vi.fn().mockImplementation(async (_actor, input) => {
        createOrderCalls++;
        if (shouldOrderServiceFail) {
          throw new Error('Database transaction serialization error');
        }
        if (input.idempotencyKey === 'already-processed-idempotency-key') {
          throw new ValidationError('An order has already been created for idempotency key');
        }
      }),
    } as unknown as OrderService;

    const orderConsumer = new OrderEventConsumer(
      db,
      outboxRepo,
      transport,
      logger,
      mockOrderService,
    );
    orderConsumer.registerSubscriptions();

    const event: DomainEvent = {
      eventId: `evt-payment-${randomUUID()}`,
      eventType: EventTypes.PAYMENT_SUCCEEDED,
      eventVersion: 1,
      aggregateType: 'PaymentIntent',
      aggregateId: 'pi_test_123',
      tenantId: 'tenant-test-1',
      occurredAt: new Date().toISOString(),
      payload: {
        checkoutSessionId: 'chk_test_123',
      },
      metadata: {},
    };
    await persistOutboxEvent(event);

    // 1. Initial attempt fails due to transient database serialization error
    const firstResult = await orderConsumer.process(event);
    expect(firstResult.handled).toBe(false);
    expect(firstResult.error).toBe('Database transaction serialization error');
    expect(createOrderCalls).toBe(1);

    const receiptFailed = await outboxRepo.findReceipt(db, 'order-processor', event.eventId);
    expect(receiptFailed?.status).toBe('FAILED');

    // 2. Transient error clears; durable consumer retry executes
    shouldOrderServiceFail = false;
    const retryResult = await orderConsumer.retryFailedEvents({ baseRetryDelayMs: 0 });
    expect(retryResult.succeeded).toBe(1);
    expect(createOrderCalls).toBe(2);

    const receiptSuccess = await outboxRepo.findReceipt(db, 'order-processor', event.eventId);
    expect(receiptSuccess?.status).toBe('COMPLETED');

    // 3. Duplicate event redelivery triggers idempotency guard in OrderEventConsumer
    const duplicateResult = await orderConsumer.process(event);
    expect(duplicateResult.duplicate).toBe(true);
    expect(duplicateResult.handled).toBe(false);
    // OrderService was not called again for deduplicated delivery
    expect(createOrderCalls).toBe(2);

    // 4. Verify OrderEventConsumer idempotency handling when OrderService throws idempotency key ValidationError
    const mockOrderServiceIdempotent = {
      createOrderFromCheckout: vi.fn().mockRejectedValue(
        new ValidationError('An order has already been created for idempotency key'),
      ),
    } as unknown as OrderService;

    const consumerIdempotent = new OrderEventConsumer(
      db,
      outboxRepo,
      transport,
      logger,
      mockOrderServiceIdempotent,
    );
    const newEvent: DomainEvent = {
      ...event,
      eventId: `evt-payment-${randomUUID()}`,
    };
    await persistOutboxEvent(newEvent);

    const res = await consumerIdempotent.process(newEvent);
    // When OrderService signals idempotency key conflict, consumer treats it as completed
    expect(res.handled).toBe(true);
    const receiptIdempotent = await outboxRepo.findReceipt(db, 'order-processor', newEvent.eventId);
    expect(receiptIdempotent?.status).toBe('COMPLETED');
  });

  // --- 8. Retry exhaustion produces a visible terminal state and useful diagnostics ---
  it('8. Retry exhaustion produces a visible terminal state and useful diagnostics', async () => {
    class FailingConsumerWithLimits extends BaseEventConsumer {
      constructor() {
        super('quarantine-consumer', db, outboxRepo, transport, logger, {
          maxAttempts: 3,
          baseRetryDelayMs: 0,
        });
      }
      registerSubscriptions(): void {}
      protected async handleEvent(): Promise<void> {
        throw new Error('Fatal unrecoverable payload error');
      }
    }

    const consumer = new FailingConsumerWithLimits();
    const event = createTestEvent();
    await persistOutboxEvent(event);

    // Attempt 1
    const res1 = await consumer.process(event);
    expect(res1.handled).toBe(false);
    expect(res1.quarantined).toBe(false);
    let r = await outboxRepo.findReceipt(db, 'quarantine-consumer', event.eventId);
    expect(r?.status).toBe('FAILED');
    expect(r?.errorMetadata).toMatchObject({ attempts: 1 });

    // Attempt 2
    const res2 = await consumer.retryFailedEvents({ baseRetryDelayMs: 0 });
    expect(res2.failed).toBe(1);
    r = await outboxRepo.findReceipt(db, 'quarantine-consumer', event.eventId);
    expect(r?.status).toBe('FAILED');
    expect(r?.errorMetadata).toMatchObject({ attempts: 2 });

    // Attempt 3 (reaches maxAttempts = 3) -> QUARANTINED
    const res3 = await consumer.retryFailedEvents({ baseRetryDelayMs: 0 });
    expect(res3.quarantined).toBe(1);
    r = await outboxRepo.findReceipt(db, 'quarantine-consumer', event.eventId);
    expect(r?.status).toBe('QUARANTINED');
    expect(r?.errorMetadata).toMatchObject({
      attempts: 3,
      reason: 'Exceeded maximum retry attempts (3)',
      lastError: 'Fatal unrecoverable payload error',
    });
    expect(r?.errorMetadata?.quarantinedAt).toBeDefined();

    // Subsequent retries ignore quarantined event
    const res4 = await consumer.retryFailedEvents({ baseRetryDelayMs: 0 });
    expect(res4.claimed).toBe(0);
    expect(res4.retried).toBe(0);
  });

  // --- 9. Scheduler overlap prevention and shutdown cleanup ---
  it('9. Scheduler overlap prevention and shutdown cleanup', async () => {
    let retryCalls = 0;

    class MockConsumer extends BaseEventConsumer {
      constructor() {
        super('mock-consumer', db, outboxRepo, transport, logger);
      }
      registerSubscriptions(): void {}
      protected async handleEvent(): Promise<void> {}
      override async retryFailedEvents(): Promise<{ claimed: number; retried: number; succeeded: number; failed: number; quarantined: number }> {
        retryCalls++;
        return { claimed: 0, retried: 0, succeeded: 0, failed: 0, quarantined: 0 };
      }
    }

    const mockConsumer = new MockConsumer();
    const runner = new ConsumerRetryRunner(logger, { intervalMs: 50 });
    runner.registerConsumer(mockConsumer);

    expect(runner.getRegisteredConsumers()).toHaveLength(1);
    expect(runner.isRunning).toBe(false);

    // Start runner
    runner.start();
    expect(runner.isRunning).toBe(true);

    // Calling start() again is idempotent
    runner.start();
    expect(runner.isRunning).toBe(true);

    // Wait for at least one cycle
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(retryCalls).toBeGreaterThanOrEqual(1);

    // Stop runner
    runner.stop();
    expect(runner.isRunning).toBe(false);

    const callCountAfterStop = retryCalls;
    await new Promise((resolve) => setTimeout(resolve, 80));
    // No further calls occur after stop()
    expect(retryCalls).toBe(callCountAfterStop);
  });

  // --- 10. ConsumerRetryRunner integration with Fastify app and onClose cleanup ---
  it('10. App integrates ConsumerRetryRunner and cleans up on shutdown', async () => {
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
      ACCESS_TOKEN_SECRET: 'super-secret-key-at-least-16-chars',
      SERVICE_NAME: 'test-api',
      LOG_PRETTY: 'false',
      REDACT_KEYS: 'password,token',
    });

    const app: FastifyInstance = await buildApp({
      config,
      dbConnection: db,
      skipMigrations: true,
      enableBackgroundWorkers: true, // test background runner initialization
    });
    await app.ready();

    // Verify consumerRetryRunner is decorated on the app
    expect(app.consumerRetryRunner).toBeDefined();
    const runner = app.consumerRetryRunner!;
    expect(runner).toBeInstanceOf(ConsumerRetryRunner);
    expect(runner.isRunning).toBe(true);

    // Verify all registered consumers are present in the runner
    const registered = runner.getRegisteredConsumers();
    const consumerNames = registered.map((c) => c.consumerName);
    expect(consumerNames).toContain('search-projector');
    expect(consumerNames).toContain('order-processor');
    expect(consumerNames).toContain('analytics-ingestor');
    expect(consumerNames).toContain('recommendations-ingestor');

    // Close app: onClose hook must stop runner
    await app.close();
    expect(runner.isRunning).toBe(false);
  });

  // --- 11. Quarantine race: quarantine update does not overwrite COMPLETED receipt ---
  it('11. Quarantine race: quarantine update does not overwrite COMPLETED receipt', async () => {
    class ExhaustedConsumer extends BaseEventConsumer {
      constructor() {
        super('exhausted-consumer', db, outboxRepo, transport, logger, {
          maxAttempts: 3,
        });
      }
      registerSubscriptions(): void {}
      protected async handleEvent(): Promise<void> {}
    }

    const consumer = new ExhaustedConsumer();
    const event = createTestEvent();
    await persistOutboxEvent(event);

    // Initial receipt has already reached maxAttempts (3) and is FAILED
    await db.query(
      `INSERT INTO event_consumer_receipts (
        id, consumer_name, event_id, status, error_metadata, processed_at, created_at
      ) VALUES ($1, $2, $3, 'FAILED', $4, NOW(), NOW())`,
      [
        randomUUID(),
        'exhausted-consumer',
        event.eventId,
        JSON.stringify({ attempts: 3, lastError: 'Prior timeout' }),
      ],
    );

    // Worker B completes the receipt concurrently right as Worker A is checking exhaustion
    const originalQuery = db.query.bind(db);
    let workerBCompleted = false;

    const querySpy = vi.spyOn(db, 'query').mockImplementation(async (sql: string, params?: unknown[]) => {
      // Intercept Worker A right before it attempts the QUARANTINED update
      if (typeof sql === 'string' && sql.includes("SET status = 'QUARANTINED'") && !workerBCompleted) {
        workerBCompleted = true;
        // Concurrent Worker B completes the receipt in the database!
        await originalQuery(
          `UPDATE event_consumer_receipts
           SET status = 'COMPLETED', error_metadata = NULL, processed_at = NOW()
           WHERE consumer_name = $1 AND event_id = $2`,
          ['exhausted-consumer', event.eventId],
        );
      }
      return originalQuery(sql, params);
    });

    try {
      // Worker A attempts to process the event
      const result = await consumer.process(event);

      // Worker A must recognize that receipt was completed by concurrent worker and NOT overwrite it!
      expect(result.quarantined).toBe(false);
      expect(result.duplicate).toBe(true);

      // Verify database receipt is STILL COMPLETED, not QUARANTINED!
      const receiptInDb = await outboxRepo.findReceipt(db, 'exhausted-consumer', event.eventId);
      expect(receiptInDb?.status).toBe('COMPLETED');
      expect(receiptInDb?.errorMetadata).toBeNull();
    } finally {
      querySpy.mockRestore();
    }
  });

  // --- 12. Head-of-line blocking elimination via SQL nextRetryAt filtering ---
  it('12. Eliminates head-of-line blocking by filtering ineligible receipts in SQL before LIMIT', async () => {
    let handledCount = 0;

    class HolConsumer extends BaseEventConsumer {
      constructor() {
        super('hol-consumer', db, outboxRepo, transport, logger, {
          maxAttempts: 5,
        });
      }
      registerSubscriptions(): void {}
      protected async handleEvent(): Promise<void> {
        handledCount++;
      }
    }

    const consumer = new HolConsumer();

    // 1. Insert 5 ineligible FAILED receipts with nextRetryAt set 1 hour in the future
    const futureIso = new Date(Date.now() + 3600_000).toISOString();
    for (let i = 0; i < 5; i++) {
      const ineligibleEvt = createTestEvent();
      await persistOutboxEvent(ineligibleEvt);
      await db.query(
        `INSERT INTO event_consumer_receipts (
          id, consumer_name, event_id, status, error_metadata, processed_at, created_at
        ) VALUES ($1, $2, $3, 'FAILED', $4, NOW(), NOW())`,
        [
          randomUUID(),
          'hol-consumer',
          ineligibleEvt.eventId,
          JSON.stringify({ attempts: 1, nextRetryAt: futureIso, lastError: 'Too early' }),
        ],
      );
    }

    // 2. Insert 1 eligible FAILED receipt with nextRetryAt in the past
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    const eligibleEvt = createTestEvent();
    await persistOutboxEvent(eligibleEvt);
    await db.query(
      `INSERT INTO event_consumer_receipts (
        id, consumer_name, event_id, status, error_metadata, processed_at, created_at
      ) VALUES ($1, $2, $3, 'FAILED', $4, NOW(), NOW())`,
      [
        randomUUID(),
        'hol-consumer',
        eligibleEvt.eventId,
        JSON.stringify({ attempts: 1, nextRetryAt: pastIso, lastError: 'Eligible now' }),
      ],
    );

    // 3. Run retry with batchSize = 3 (smaller than the 5 ineligible receipts!)
    // If head-of-line blocking existed, the query would grab 3 ineligible receipts and process 0.
    // With SQL filtering on nextRetryAt, the query skips ineligible receipts and finds the eligible one!
    const retryResult = await consumer.retryFailedEvents({ batchSize: 3 });

    expect(retryResult.claimed).toBe(1);
    expect(retryResult.succeeded).toBe(1);
    expect(handledCount).toBe(1);

    // Verify the eligible receipt completed
    const eligibleReceipt = await outboxRepo.findReceipt(db, 'hol-consumer', eligibleEvt.eventId);
    expect(eligibleReceipt?.status).toBe('COMPLETED');
  });
});

