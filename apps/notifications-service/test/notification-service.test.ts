import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from './helpers/test-db.js';
import { NotificationRepository } from '../src/repository/notification-repository.js';
import { NotificationService } from '../src/domain/notification-service.js';
import { DatabaseConnection } from '../src/infra/database/connection.js';
import { InMemoryEmailProvider, InMemorySmsProvider, InMemoryPushProvider } from '../src/channels/in-memory-providers.js';

describe('NotificationService Domain Logic', () => {
  let db: DatabaseConnection;
  let repo: NotificationRepository;
  let emailProvider: InMemoryEmailProvider;
  let smsProvider: InMemorySmsProvider;
  let pushProvider: InMemoryPushProvider;
  let service: NotificationService;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new NotificationRepository(db);
    emailProvider = new InMemoryEmailProvider();
    smsProvider = new InMemorySmsProvider();
    pushProvider = new InMemoryPushProvider();
    service = new NotificationService(
      repo,
      {
        email: emailProvider,
        sms: smsProvider,
        push: pushProvider,
      },
      undefined,
      {
        claimTimeoutMs: 60000,
        maxRetries: 3,
        initialRetryDelayMs: 100,
      },
    );
  });

  afterEach(async () => {
    await db.end();
  });

  it('creates a notification request', async () => {
    const result = await service.requestNotification({
      tenantId: 'tenant-1',
      eventId: 'evt-order-1001',
      notificationType: 'ORDER_CONFIRMATION',
      channel: 'EMAIL',
      recipient: 'user@example.com',
      payload: { orderNumber: '1001' },
    });

    expect(result.notificationId).toBeDefined();
    expect(result.status).toBe('PENDING');
    expect(result.recipient).toBe('user@example.com');
  });

  it('rejects missing, empty, and whitespace-only event IDs', async () => {
    // 1. Missing eventId
    await expect(
      service.requestNotification({
        tenantId: 'tenant-1',
        notificationType: 'ORDER_CONFIRMATION',
        channel: 'EMAIL',
        recipient: 'user@example.com',
        payload: {},
      } as any),
    ).rejects.toThrow('eventId is required and must be a non-empty string');

    // 2. Empty string eventId
    await expect(
      service.requestNotification({
        tenantId: 'tenant-1',
        eventId: '',
        notificationType: 'ORDER_CONFIRMATION',
        channel: 'EMAIL',
        recipient: 'user@example.com',
        payload: {},
      }),
    ).rejects.toThrow('eventId is required and must be a non-empty string');

    // 3. Whitespace-only eventId
    await expect(
      service.requestNotification({
        tenantId: 'tenant-1',
        eventId: '   ',
        notificationType: 'ORDER_CONFIRMATION',
        channel: 'EMAIL',
        recipient: 'user@example.com',
        payload: {},
      }),
    ).rejects.toThrow('eventId is required and must be a non-empty string');

    // 4. Non-string eventId
    await expect(
      service.requestNotification({
        tenantId: 'tenant-1',
        eventId: 12345 as any,
        notificationType: 'ORDER_CONFIRMATION',
        channel: 'EMAIL',
        recipient: 'user@example.com',
        payload: {},
      }),
    ).rejects.toThrow('eventId is required and must be a non-empty string');
  });

  it('enforces idempotency on duplicate notification requests with explicit idempotencyKey', async () => {
    const res1 = await service.requestNotification({
      tenantId: 'tenant-1',
      eventId: 'evt-order-1001',
      notificationType: 'ORDER_CONFIRMATION',
      channel: 'EMAIL',
      recipient: 'user@example.com',
      payload: { orderNumber: '1001' },
      idempotencyKey: 'idem-key-1',
    });

    const res2 = await service.requestNotification({
      tenantId: 'tenant-1',
      eventId: 'evt-order-1001',
      notificationType: 'ORDER_CONFIRMATION',
      channel: 'EMAIL',
      recipient: 'user@example.com',
      payload: { orderNumber: '1001' },
      idempotencyKey: 'idem-key-1',
    });

    expect(res1.notificationId).toBe(res2.notificationId);
  });

  it('enforces idempotency on duplicate notification requests with deterministic eventId and derived idempotencyKey', async () => {
    const res1 = await service.requestNotification({
      tenantId: 'tenant-1',
      eventId: 'evt-deterministic-99',
      notificationType: 'ORDER_CONFIRMATION',
      channel: 'EMAIL',
      recipient: 'user@example.com',
      payload: { orderNumber: '1001' },
    });

    const res2 = await service.requestNotification({
      tenantId: 'tenant-1',
      eventId: 'evt-deterministic-99',
      notificationType: 'ORDER_CONFIRMATION',
      channel: 'EMAIL',
      recipient: 'user@example.com',
      payload: { orderNumber: '1001' },
    });

    expect(res1.notificationId).toBe(res2.notificationId);
    expect(res1.idempotencyKey).toBe('evt-deterministic-99:ORDER_CONFIRMATION:user@example.com:EMAIL');
    expect(res2.idempotencyKey).toBe(res1.idempotencyKey);
  });

  it('respects customer preferences and suppresses notification if channel disabled', async () => {
    // Disable EMAIL for customer
    await service.setCustomerPreferences('tenant-1', 'cust-1', {
      emailEnabled: false,
    });

    const res = await service.requestNotification({
      tenantId: 'tenant-1',
      customerId: 'cust-1',
      eventId: 'evt-pref-1',
      notificationType: 'ORDER_CONFIRMATION',
      channel: 'EMAIL',
      recipient: 'cust@example.com',
      payload: {},
    });

    expect(res.status).toBe('SKIPPED');
    expect(res.skipped).toBe(true);
  });

  it('dispatches pending notifications to channel provider on processPendingNotifications', async () => {
    await service.requestNotification({
      tenantId: 'tenant-1',
      eventId: 'evt-pending-1',
      notificationType: 'ORDER_CONFIRMATION',
      channel: 'EMAIL',
      recipient: 'recipient@example.com',
      payload: { subject: 'Welcome!', body: 'Hello world' },
    });

    const processResult = await service.processPendingNotifications({ batchSize: 10 });
    expect(processResult.processed).toBe(1);
    expect(processResult.sent).toBe(1);
    expect(processResult.failed).toBe(0);

    const sentEmails = emailProvider.getSentEmails();
    expect(sentEmails.length).toBe(1);
    expect(sentEmails[0]!.to).toBe('recipient@example.com');
  });

  it('handles retry and exponential backoff upon channel failure', async () => {
    emailProvider.setSimulateFailure(true);

    const created = await service.requestNotification({
      tenantId: 'tenant-1',
      eventId: 'evt-retry-1',
      notificationType: 'ORDER_CONFIRMATION',
      channel: 'EMAIL',
      recipient: 'fail@example.com',
      payload: {},
    });

    const processResult = await service.processPendingNotifications({ batchSize: 10 });
    expect(processResult.failed).toBe(1);

    const record = await service.getNotificationById(created.notificationId);
    expect(record.status).toBe('RETRY_SCHEDULED');
    expect(record.attemptCount).toBe(1);
    expect(record.lastError).toContain('SMTP connection timed out');
  });

  it('moves notification to DEAD_LETTER when max retries exceeded', async () => {
    const notif = {
      id: 'notif-dead',
      tenantId: 'tenant-1',
      eventId: 'evt-dead',
      idempotencyKey: 'idemp-dead',
      notificationType: 'ORDER_CONFIRMATION',
      channel: 'EMAIL' as const,
      recipient: 'dead@example.com',
      templateId: 'tpl_order',
      payload: {},
      status: 'PENDING' as const,
      attemptCount: 0,
      maxAttempts: 1,
      availableAt: new Date(Date.now() - 1000).toISOString(),
      sentAt: null,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await repo.insertNotification(notif);

    emailProvider.setSimulateFailure(true);
    await service.processPendingNotifications({ batchSize: 10 });

    const record = await service.getNotificationById('notif-dead');
    expect(record.status).toBe('DEAD_LETTERED');
    expect(record.attemptCount).toBe(1);
  });

  it('allows administrator to manually retry DEAD_LETTERED notification', async () => {
    const notif = {
      id: 'notif-retry-admin',
      tenantId: 'tenant-1',
      eventId: 'evt-retry',
      idempotencyKey: 'idemp-retry-admin',
      notificationType: 'ORDER_CONFIRMATION',
      channel: 'EMAIL' as const,
      recipient: 'retry@example.com',
      templateId: 'tpl_order',
      payload: {},
      status: 'DEAD_LETTERED' as const,
      attemptCount: 3,
      maxAttempts: 3,
      availableAt: new Date().toISOString(),
      sentAt: null,
      lastError: 'Permanent failure',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await repo.insertNotification(notif);

    const reset = await service.retryNotification('notif-retry-admin');
    expect(reset.status).toBe('PENDING');
    expect(reset.attemptCount).toBe(0);
  });

  it('supports synchronous sendTransactionalEmail returning providerMessageId', async () => {
    const res = await service.sendTransactionalEmail({
      tenantId: 'tenant-1',
      recipient: 'tx@example.com',
      subject: 'Your Password Reset',
      body: 'Click here to reset your password.',
    });

    expect(res.providerMessageId).toBeDefined();
    expect(typeof res.providerMessageId).toBe('string');

    // Also supports simple 3-arg signature (to, subject, body)
    const directRes = await service.sendTransactionalEmail(
      'verify@example.com',
      'Verify Your Account',
      'Click link to verify',
    );
    expect(directRes.providerMessageId).toBeDefined();

    // Does NOT pollute or enqueue into notifications table
    const tableItems = await repo.listNotifications({ tenantId: 'tenant-1' });
    expect(tableItems.items.length).toBe(0);
  });

  it('rejects invalid inputs on sendTransactionalEmail', async () => {
    await expect(
      service.sendTransactionalEmail('', 'Subject', 'Body'),
    ).rejects.toThrow('Valid recipient email address is required');

    await expect(
      service.sendTransactionalEmail('user@test.com', '', 'Body'),
    ).rejects.toThrow('Email subject is required');
  });
});
