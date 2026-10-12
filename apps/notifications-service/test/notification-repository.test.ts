import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from './helpers/test-db.js';
import { NotificationRepository } from '../src/repository/notification-repository.js';
import { DatabaseConnection } from '../src/infra/database/connection.js';

describe('NotificationRepository (Isolated Persistence Layer)', () => {
  let db: DatabaseConnection;
  let repo: NotificationRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new NotificationRepository(db);
  });

  afterEach(async () => {
    await db.end();
  });

  it('proves that repository only requires service-owned tables and no foreign monolith tables', async () => {
    // 1. Service-owned tables exist and can be queried
    const notifCount = await db.query<{ count: string | number }>(
      'SELECT count(*) FROM notifications',
    );
    expect(Number(notifCount.rows[0]?.count)).toBe(0);

    const prefCount = await db.query<{ count: string | number }>(
      'SELECT count(*) FROM customer_notification_preferences',
    );
    expect(Number(prefCount.rows[0]?.count)).toBe(0);

    const receiptCount = await db.query<{ count: string | number }>(
      'SELECT count(*) FROM notification_consumer_receipts',
    );
    expect(Number(receiptCount.rows[0]?.count)).toBe(0);

    // 2. Foreign monolith tables DO NOT exist in isolated service database
    await expect(db.query('SELECT * FROM users')).rejects.toThrow();
    await expect(db.query('SELECT * FROM products')).rejects.toThrow();
    await expect(db.query('SELECT * FROM orders')).rejects.toThrow();
    await expect(db.query('SELECT * FROM inventory_items')).rejects.toThrow();
    await expect(db.query('SELECT * FROM payments')).rejects.toThrow();
  });

  it('creates and retrieves a notification record', async () => {
    const notif = {
      id: 'notif-1',
      tenantId: 'tenant-123',
      customerId: 'cust-456',
      eventId: 'evt-789',
      idempotencyKey: 'idemp-1',
      notificationType: 'ORDER_CONFIRMATION',
      channel: 'EMAIL' as const,
      recipient: 'customer@example.com',
      templateId: 'tpl_order',
      payload: { orderId: 'ord-1' },
      status: 'PENDING' as const,
      attemptCount: 0,
      maxAttempts: 3,
      availableAt: new Date().toISOString(),
      sentAt: null,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await repo.insertNotification(notif);

    const fetched = await repo.getNotificationById('notif-1');
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe('notif-1');
    expect(fetched?.tenantId).toBe('tenant-123');
    expect(fetched?.recipient).toBe('customer@example.com');
    expect(fetched?.status).toBe('PENDING');
  });

  it('claims pending notifications atomically and updates delivery status', async () => {
    const notif = {
      id: 'notif-claim',
      tenantId: 'tenant-123',
      eventId: 'evt-claim',
      idempotencyKey: 'idemp-claim',
      notificationType: 'PAYMENT_RECEIPT',
      channel: 'EMAIL' as const,
      recipient: 'user@test.com',
      templateId: 'tpl_payment',
      payload: { amount: 100 },
      status: 'PENDING' as const,
      attemptCount: 0,
      maxAttempts: 3,
      availableAt: new Date(Date.now() - 1000).toISOString(),
      sentAt: null,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await repo.insertNotification(notif);

    const claimed = await repo.claimPendingNotifications(10);
    expect(claimed.length).toBe(1);
    expect(claimed[0]!.id).toBe('notif-claim');
    expect(claimed[0]!.status).toBe('PROCESSING');

    // Update to sent
    await repo.markSent('notif-claim');

    const sent = await repo.getNotificationById('notif-claim');
    expect(sent?.status).toBe('SENT');
    expect(sent?.sentAt).not.toBeNull();
  });

  it('saves and retrieves customer preferences', async () => {
    const defaultPref = await repo.findCustomerPreferences('tenant-1', 'cust-1');
    expect(defaultPref).toBeNull();

    await repo.upsertCustomerPreferences({
      id: 'pref-1',
      tenantId: 'tenant-1',
      customerId: 'cust-1',
      emailEnabled: true,
      smsEnabled: false,
      pushEnabled: true,
      disabledTypes: ['PRICE_DROP_ALERT'],
    });

    const fetched = await repo.findCustomerPreferences('tenant-1', 'cust-1');
    expect(fetched).not.toBeNull();
    expect(fetched?.emailEnabled).toBe(true);
    expect(fetched?.smsEnabled).toBe(false);
    expect(fetched?.disabledTypes).toEqual(['PRICE_DROP_ALERT']);
  });

  it('records and checks consumer receipts for idempotency', async () => {
    const isProcessedBefore = await repo.isEventProcessed('notification-dispatcher', 'evt-999');
    expect(isProcessedBefore).toBe(false);

    await repo.recordEventReceipt({
      consumerName: 'notification-dispatcher',
      eventId: 'evt-999',
      eventType: 'order.created.v1',
    });

    const isProcessedAfter = await repo.isEventProcessed('notification-dispatcher', 'evt-999');
    expect(isProcessedAfter).toBe(true);
  });
});
