import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from './helpers/test-db.js';
import { NotificationRepository } from '../src/repository/notification-repository.js';
import { NotificationService } from '../src/domain/notification-service.js';
import { InMemoryEmailProvider, InMemorySmsProvider, InMemoryPushProvider } from '../src/channels/in-memory-providers.js';
import { NotificationEventConsumer } from '../src/events/notification-event-consumer.js';
import { NotificationEventTypes, DomainEvent, EventMetadata } from '../src/events/event-models.js';
import { DatabaseConnection } from '../src/infra/database/connection.js';

describe('NotificationEventConsumer Boundary', () => {
  let db: DatabaseConnection;
  let repo: NotificationRepository;
  let service: NotificationService;
  let consumer: NotificationEventConsumer;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new NotificationRepository(db);
    service = new NotificationService(repo, {
      email: new InMemoryEmailProvider(),
      sms: new InMemorySmsProvider(),
      push: new InMemoryPushProvider(),
    });
    consumer = new NotificationEventConsumer(service, repo);
  });

  afterEach(async () => {
    await db.end();
  });

  function makeEvent(
    eventType: string,
    payload: Record<string, unknown>,
    aggregateId = 'agg-1',
    metadata: EventMetadata = { source: 'test-suite' },
  ): DomainEvent {
    return {
      eventId: `evt-${Math.random().toString(36).slice(2, 9)}`,
      eventType,
      eventVersion: 1,
      aggregateType: 'test',
      aggregateId,
      tenantId: 'tenant-test',
      occurredAt: new Date().toISOString(),
      payload,
      metadata,
    };
  }

  it('handles order.created.v1 event and requests order confirmation notification', async () => {
    const event = makeEvent(NotificationEventTypes.ORDER_CREATED, {
      customerEmail: 'order@example.com',
      customerId: 'cust-1',
      totalAmount: 150.0,
    }, 'order-123');

    const processed = await consumer.process(event);
    expect(processed).toEqual({
      status: 'PROCESSED',
      eventId: event.eventId,
    });

    const notifications = await repo.listNotifications({ tenantId: 'tenant-test' });
    expect(notifications.items.length).toBe(1);
    expect(notifications.items[0]!.notificationType).toBe('ORDER_CONFIRMATION');
    expect(notifications.items[0]!.recipient).toBe('order@example.com');
  });

  it('handles payment.succeeded.v1 event', async () => {
    const event = makeEvent(NotificationEventTypes.PAYMENT_SUCCEEDED, {
      customerEmail: 'pay@example.com',
      amount: 150.0,
      currency: 'USD',
    }, 'pi-123');

    const result = await consumer.process(event);
    expect(result.status).toBe('PROCESSED');
    const notifications = await repo.listNotifications({ tenantId: 'tenant-test' });
    expect(notifications.items.length).toBe(1);
    expect(notifications.items[0]!.notificationType).toBe('PAYMENT_RECEIPT');
  });

  it('handles payment.failed.v1 event', async () => {
    const event = makeEvent(NotificationEventTypes.PAYMENT_FAILED, {
      customerEmail: 'fail@example.com',
      amount: 150.0,
      reason: 'Insufficient funds',
    }, 'pi-failed');

    const result = await consumer.process(event);
    expect(result.status).toBe('PROCESSED');
    const notifications = await repo.listNotifications({ tenantId: 'tenant-test' });
    expect(notifications.items.length).toBe(1);
    expect(notifications.items[0]!.notificationType).toBe('PAYMENT_FAILURE_ALERT');
  });

  it('handles fulfillment.shipment_status_changed.v1 event', async () => {
    const event = makeEvent(NotificationEventTypes.FULFILLMENT_SHIPMENT_STATUS_CHANGED, {
      customerEmail: 'ship@example.com',
      status: 'IN_TRANSIT',
      trackingNumber: 'TRACK123',
    }, 'ship-1');

    const result = await consumer.process(event);
    expect(result.status).toBe('PROCESSED');
    const notifications = await repo.listNotifications({ tenantId: 'tenant-test' });
    expect(notifications.items.length).toBe(1);
    expect(notifications.items[0]!.notificationType).toBe('SHIPMENT_STATUS_UPDATE');
  });

  it('handles fulfillment.return_status_changed.v1 event', async () => {
    const event = makeEvent(NotificationEventTypes.FULFILLMENT_RETURN_STATUS_CHANGED, {
      customerEmail: 'return@example.com',
      status: 'APPROVED',
    }, 'ret-1');

    const result = await consumer.process(event);
    expect(result.status).toBe('PROCESSED');
    const notifications = await repo.listNotifications({ tenantId: 'tenant-test' });
    expect(notifications.items.length).toBe(1);
    expect(notifications.items[0]!.notificationType).toBe('RETURN_STATUS_UPDATE');
  });

  it('handles settlement.status_changed.v1 event', async () => {
    const event = makeEvent(NotificationEventTypes.SETTLEMENT_STATUS_CHANGED, {
      merchantEmail: 'merchant@example.com',
      status: 'COMPLETED',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-07',
      netPayableAmount: 1200.0,
      currency: 'USD',
    }, 'settle-1');

    const result = await consumer.process(event);
    expect(result.status).toBe('PROCESSED');
    const notifications = await repo.listNotifications({ tenantId: 'tenant-test' });
    expect(notifications.items.length).toBe(1);
    expect(notifications.items[0]!.notificationType).toBe('SETTLEMENT_UPDATE');
    expect(notifications.items[0]!.recipient).toBe('merchant@example.com');
  });

  it('ensures idempotent processing: drops duplicate events using consumer receipt table', async () => {
    const event = makeEvent(NotificationEventTypes.ORDER_CREATED, {
      customerEmail: 'duplicate@example.com',
    }, 'order-dup');

    const firstRun = await consumer.process(event);
    expect(firstRun).toEqual({
      status: 'PROCESSED',
      eventId: event.eventId,
    });

    const secondRun = await consumer.process(event);
    expect(secondRun).toEqual({
      status: 'ALREADY_COMPLETED',
      eventId: event.eventId,
    });

    // Notifications table should only contain 1 record
    const notifications = await repo.listNotifications({ tenantId: 'tenant-test' });
    expect(notifications.items.length).toBe(1);

    const receipt = await repo.findReceipt('notification-dispatcher', event.eventId);
    expect(receipt?.status).toBe('COMPLETED');
  });

  it('prevents concurrent duplicate deliveries from claiming the same event simultaneously', async () => {
    const event = makeEvent(NotificationEventTypes.ORDER_CREATED, {
      customerEmail: 'concurrent@example.com',
    }, 'order-conc');

    const consumerA = new NotificationEventConsumer(service, repo);
    const consumerB = new NotificationEventConsumer(service, repo);

    const [resA, resB] = await Promise.all([
      consumerA.process(event),
      consumerB.process(event),
    ]);

    // Exactly one worker must succeed (PROCESSED), the other must safely yield (CURRENTLY_PROCESSING)
    const statuses = [resA.status, resB.status];
    expect(statuses).toContain('PROCESSED');
    expect(statuses).toContain('CURRENTLY_PROCESSING');

    const notifications = await repo.listNotifications({ tenantId: 'tenant-test' });
    const match = notifications.items.filter((n) => n.recipient === 'concurrent@example.com');
    expect(match.length).toBe(1);
  });

  it('records FAILED status on handler failure and allows successful retry on redelivery', async () => {
    const event = makeEvent(NotificationEventTypes.ORDER_CREATED, {
      customerEmail: 'retry@example.com',
    }, 'order-retry', { correlationId: 'corr-retry-1', source: 'monolith' });

    let failFirst = true;

    class FailingConsumer extends NotificationEventConsumer {
      protected override async handleEvent(evt: DomainEvent): Promise<void> {
        if (failFirst) {
          throw new Error('Simulated transient downstream error with bearer secret-token-xyz');
        }
        return super.handleEvent(evt);
      }
    }

    const testConsumer = new FailingConsumer(service, repo);

    // First attempt fails
    const firstAttempt = await testConsumer.process(event);
    expect(firstAttempt.status).toBe('FAILED');
    if (firstAttempt.status === 'FAILED') {
      expect(firstAttempt.error).toContain('Simulated transient downstream error');
      // Verify sensitive token was redacted
      expect(firstAttempt.error).not.toContain('secret-token-xyz');
      expect(firstAttempt.error).toContain('[REDACTED]');
    }

    // Durable receipt must be marked FAILED with error and metadata
    const failedReceipt = await repo.findReceipt('notification-dispatcher', event.eventId);
    expect(failedReceipt?.status).toBe('FAILED');
    expect(failedReceipt?.errorMetadata).toMatchObject({
      error: expect.stringContaining('Simulated transient downstream error'),
      metadata: { correlationId: 'corr-retry-1', source: 'monolith' },
    });

    // Second attempt (retry delivery) succeeds
    failFirst = false;
    const retryAttempt = await testConsumer.process(event);
    expect(retryAttempt).toEqual({
      status: 'PROCESSED',
      eventId: event.eventId,
    });

    // Durable receipt must now be marked COMPLETED
    const completedReceipt = await repo.findReceipt('notification-dispatcher', event.eventId);
    expect(completedReceipt?.status).toBe('COMPLETED');

    // Third attempt is deduplicated as ALREADY_COMPLETED
    const thirdAttempt = await testConsumer.process(event);
    expect(thirdAttempt).toEqual({
      status: 'ALREADY_COMPLETED',
      eventId: event.eventId,
    });
  });

  it('safely reclaims stale PROCESSING claims from crashed workers', async () => {
    const event = makeEvent(NotificationEventTypes.ORDER_CREATED, {
      customerEmail: 'stale@example.com',
    }, 'order-stale');

    // Insert an artificially stale receipt (processed 10 minutes ago)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await repo.recordReceipt({
      id: 'stale-rcpt-1',
      consumerName: 'notification-dispatcher',
      eventId: event.eventId,
      status: 'PROCESSING',
    });

    // Update the timestamp in DB to simulate crash 10 minutes ago
    await db.query(
      `UPDATE notification_consumer_receipts SET processed_at = $1 WHERE event_id = $2`,
      [tenMinutesAgo, event.eventId],
    );

    // Consumer with 1-minute stale timeout should detect stale claim and reclaim it
    const fastStaleConsumer = new NotificationEventConsumer(service, repo, undefined, {
      staleTimeoutMs: 60 * 1000,
    });

    const reclaimedResult = await fastStaleConsumer.process(event);
    expect(reclaimedResult).toEqual({
      status: 'PROCESSED',
      eventId: event.eventId,
    });

    const receipt = await repo.findReceipt('notification-dispatcher', event.eventId);
    expect(receipt?.status).toBe('COMPLETED');
  });

  it('prevents competing workers from simultaneously reclaiming the same stale receipt via atomic CAS', async () => {
    const event = makeEvent(NotificationEventTypes.ORDER_CREATED, {
      customerEmail: 'stale-compete@example.com',
    }, 'order-stale-compete');

    // Create an artificially stale receipt
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await repo.recordReceipt({
      id: 'stale-compete-rcpt',
      consumerName: 'notification-dispatcher',
      eventId: event.eventId,
      status: 'PROCESSING',
      claimToken: 'initial-stale-token',
    });
    await db.query(
      `UPDATE notification_consumer_receipts SET processed_at = $1 WHERE event_id = $2`,
      [tenMinutesAgo, event.eventId],
    );

    const consumerA = new NotificationEventConsumer(service, repo, undefined, { staleTimeoutMs: 60 * 1000 });
    const consumerB = new NotificationEventConsumer(service, repo, undefined, { staleTimeoutMs: 60 * 1000 });

    const [resA, resB] = await Promise.all([
      consumerA.process(event),
      consumerB.process(event),
    ]);

    // Exactly one worker must succeed in acquiring the stale claim via CAS; the other yields
    const statuses = [resA.status, resB.status];
    expect(statuses).toContain('PROCESSED');
    expect(statuses).toContain('CURRENTLY_PROCESSING');

    const receipt = await repo.findReceipt('notification-dispatcher', event.eventId);
    expect(receipt?.status).toBe('COMPLETED');
  });

  it('fences receipt updates so a stale worker cannot overwrite a newer worker completion with failure', async () => {
    const event = makeEvent(NotificationEventTypes.ORDER_CREATED, {
      customerEmail: 'fencing-test@example.com',
    }, 'order-fencing');

    // 1. Worker A acquires initial claim
    const claimA = await repo.claimEventReceipt('notification-dispatcher', event.eventId);
    expect(claimA.claimed).toBe(true);
    if (!claimA.claimed) throw new Error('Expected claimA to be claimed');
    const tokenA = claimA.claimToken;

    // 2. Simulate worker A hanging and claim becoming stale
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await db.query(
      `UPDATE notification_consumer_receipts SET processed_at = $1 WHERE event_id = $2`,
      [tenMinutesAgo, event.eventId],
    );

    // 3. Worker B reclaims the stale event with a new token
    const claimB = await repo.claimEventReceipt('notification-dispatcher', event.eventId, { staleTimeoutMs: 60 * 1000 });
    expect(claimB.claimed).toBe(true);
    if (!claimB.claimed) throw new Error('Expected claimB to be claimed');
    const tokenB = claimB.claimToken;
    expect(tokenB).not.toBe(tokenA);

    // 4. Worker B successfully completes the event
    const updatedByB = await repo.updateReceiptStatus(
      'notification-dispatcher',
      event.eventId,
      'COMPLETED',
      null,
      tokenB,
    );
    expect(updatedByB).toBe(true);

    const receiptAfterB = await repo.findReceipt('notification-dispatcher', event.eventId);
    expect(receiptAfterB?.status).toBe('COMPLETED');

    // 5. Worker A wakes up late and attempts to record failure with its stale token
    const updatedByA = await repo.updateReceiptStatus(
      'notification-dispatcher',
      event.eventId,
      'FAILED',
      { error: 'Worker A crashed/delayed' },
      tokenA,
    );
    // Worker A's update must be fenced out!
    expect(updatedByA).toBe(false);

    // Durable receipt must remain COMPLETED by Worker B, not overwritten by Worker A
    const finalReceipt = await repo.findReceipt('notification-dispatcher', event.eventId);
    expect(finalReceipt?.status).toBe('COMPLETED');
  });

  it('returns FAILED when a worker loses its claim because another worker reclaimed the stale receipt', async () => {
    const event = makeEvent(NotificationEventTypes.ORDER_CREATED, {
      customerEmail: 'fencing-worker@example.com',
    }, 'order-fencing-worker');

    let slowWorkerStartedResolve: () => void;
    const slowWorkerStartedPromise = new Promise<void>((resolve) => {
      slowWorkerStartedResolve = resolve;
    });

    let reclaimDoneResolve: () => void;
    const reclaimDonePromise = new Promise<void>((resolve) => {
      reclaimDoneResolve = resolve;
    });

    class SlowWorkerConsumer extends NotificationEventConsumer {
      protected override async handleEvent(evt: DomainEvent): Promise<void> {
        slowWorkerStartedResolve();
        // Wait until Worker B reclaims the event before Worker A finishes
        await reclaimDonePromise;
        return super.handleEvent(evt);
      }
    }

    const workerA = new SlowWorkerConsumer(service, repo, undefined, { staleTimeoutMs: 60 * 1000 });
    const workerB = new NotificationEventConsumer(service, repo, undefined, { staleTimeoutMs: 60 * 1000 });

    // Worker A starts processing
    const workerAPromise = workerA.process(event);
    await slowWorkerStartedPromise;

    // While Worker A is inside handleEvent, simulate crash delay by aging receipt
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await db.query(
      `UPDATE notification_consumer_receipts SET processed_at = $1 WHERE event_id = $2`,
      [tenMinutesAgo, event.eventId],
    );

    // Worker B reclaims and completes the event
    const resB = await workerB.process(event);
    expect(resB.status).toBe('PROCESSED');

    // Now let Worker A resume and try to mark COMPLETED
    reclaimDoneResolve!();
    const resA = await workerAPromise;

    // Worker A must return FAILED because its claim was superseded!
    expect(resA).toEqual({
      status: 'FAILED',
      eventId: event.eventId,
      error: 'Event processing claim was superseded by another worker',
    });

    // Receipt must still belong to Worker B (COMPLETED)
    const receipt = await repo.findReceipt('notification-dispatcher', event.eventId);
    expect(receipt?.status).toBe('COMPLETED');
  });

  it('does not reclaim a non-stale PROCESSING claim within timeout window', async () => {
    const event = makeEvent(NotificationEventTypes.ORDER_CREATED, {
      customerEmail: 'non-stale@example.com',
    }, 'order-non-stale');

    // 1. Worker A claims the event (fresh claim)
    const claimA = await repo.claimEventReceipt('notification-dispatcher', event.eventId, {
      staleTimeoutMs: 5 * 60 * 1000,
    });
    expect(claimA.claimed).toBe(true);
    if (!claimA.claimed) throw new Error('Expected claimA to be claimed');

    // 2. Worker B attempts to reclaim while claim A is fresh (not stale)
    const claimB = await repo.claimEventReceipt('notification-dispatcher', event.eventId, {
      staleTimeoutMs: 5 * 60 * 1000,
    });
    expect(claimB.claimed).toBe(false);
    if (claimB.claimed) throw new Error('Expected claimB to fail');
    expect(claimB.reason).toBe('CURRENTLY_PROCESSING');

    // 3. Consumer process call by worker B returns CURRENTLY_PROCESSING
    const consumerB = new NotificationEventConsumer(service, repo);
    const handledByB = await consumerB.process(event);
    expect(handledByB).toEqual({
      status: 'CURRENTLY_PROCESSING',
      eventId: event.eventId,
    });

    // 4. Receipt still belongs to Worker A
    const receipt = await repo.findReceipt('notification-dispatcher', event.eventId);
    expect(receipt?.status).toBe('PROCESSING');
    expect(receipt?.claimToken).toBe(claimA.claimToken);
  });

  it('requires a valid matching claim token for all receipt status updates', async () => {
    const event = makeEvent(NotificationEventTypes.ORDER_CREATED, {
      customerEmail: 'token-validation@example.com',
    }, 'order-token-val');

    const claim = await repo.claimEventReceipt('notification-dispatcher', event.eventId);
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) throw new Error('Expected claim to be claimed');

    // Attempting update without claim token must be rejected
    const noTokenUpdate = await repo.updateReceiptStatus(
      'notification-dispatcher',
      event.eventId,
      'COMPLETED',
      null,
      undefined,
    );
    expect(noTokenUpdate).toBe(false);

    // Attempting update with empty claim token must be rejected
    const emptyTokenUpdate = await repo.updateReceiptStatus(
      'notification-dispatcher',
      event.eventId,
      'COMPLETED',
      null,
      '',
    );
    expect(emptyTokenUpdate).toBe(false);

    // Attempting update with wrong/stale claim token must be rejected
    const wrongTokenUpdate = await repo.updateReceiptStatus(
      'notification-dispatcher',
      event.eventId,
      'COMPLETED',
      null,
      'wrong-claim-token',
    );
    expect(wrongTokenUpdate).toBe(false);

    // Attempting update with correct claim token succeeds
    const validUpdate = await repo.updateReceiptStatus(
      'notification-dispatcher',
      event.eventId,
      'COMPLETED',
      null,
      claim.claimToken,
    );
    expect(validUpdate).toBe(true);

    // Subsequent update attempt after terminal state is rejected even with original token
    const subsequentUpdate = await repo.updateReceiptStatus(
      'notification-dispatcher',
      event.eventId,
      'FAILED',
      { error: 'Late error' },
      claim.claimToken,
    );
    expect(subsequentUpdate).toBe(false);
  });
});
