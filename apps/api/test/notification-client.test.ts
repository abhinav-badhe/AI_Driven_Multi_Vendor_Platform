import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  type INotificationClient,
  LocalNotificationClient,
  notificationModule,
  NotificationService,
  NotificationRepository,
  NotificationEventConsumer,
  InMemoryEmailProvider,
  InMemorySmsProvider,
  InMemoryPushProvider,
  type RequestNotificationInput,
  type NotificationResultDto,
} from '../src/modules/notifications/index.js';
import {
  createDomainEvent,
  EventTypes,
  InMemoryEventTransport,
  OutboxRepository,
} from '../src/modules/events/index.js';
import { PriceAlertService } from '../src/modules/price-alerts/index.js';
import { BackInStockService } from '../src/modules/customer/index.js';
import { JsonLogger } from '../src/observability/logger.js';
import type { DatabaseConnection } from '../src/infra/database/connection.js';

describe('Monolith Notification Client Seam (INotificationClient & LocalNotificationClient)', () => {
  let mockDb: DatabaseConnection;
  let logger: JsonLogger;

  beforeEach(() => {
    mockDb = {
      query: vi.fn(),
      withTransaction: vi.fn(),
      close: vi.fn(),
    } as unknown as DatabaseConnection;

    logger = new JsonLogger({ serviceName: 'test-notification-seam', level: 'fatal' });
  });

  describe('LocalNotificationClient Delegation', () => {
    it('delegates requestNotification to NotificationService and returns result', async () => {
      const mockResult: NotificationResultDto = {
        notificationId: 'notif-123',
        status: 'PENDING',
        channel: 'EMAIL',
        recipient: 'buyer@example.com',
        idempotencyKey: 'evt-1:ORDER_CONFIRMATION:buyer@example.com:EMAIL',
      };

      const mockService = {
        requestNotification: vi.fn().mockResolvedValue(mockResult),
        sendTransactionalEmail: vi.fn(),
        processPendingNotifications: vi.fn(),
      } as unknown as NotificationService;

      const client: INotificationClient = new LocalNotificationClient(mockService);

      const input: RequestNotificationInput = {
        tenantId: 'tenant-1',
        customerId: 'cust-1',
        eventId: 'evt-1',
        notificationType: 'ORDER_CONFIRMATION',
        channel: 'EMAIL',
        recipient: 'buyer@example.com',
        templateId: 'tpl_order_confirmation',
        payload: { orderId: 'ord-100' },
      };

      const result = await client.requestNotification(input);

      expect(mockService.requestNotification).toHaveBeenCalledTimes(1);
      expect(mockService.requestNotification).toHaveBeenCalledWith(input);
      expect(result).toEqual(mockResult);
    });

    it('delegates sendTransactionalEmail to NotificationService and returns providerMessageId', async () => {
      const mockService = {
        requestNotification: vi.fn(),
        sendTransactionalEmail: vi.fn().mockResolvedValue('msg-resend-999'),
        processPendingNotifications: vi.fn(),
      } as unknown as NotificationService;

      const client: INotificationClient = new LocalNotificationClient(mockService);

      const result = await client.sendTransactionalEmail(
        'user@example.com',
        'Verify your account',
        'Click link to verify',
      );

      expect(mockService.sendTransactionalEmail).toHaveBeenCalledTimes(1);
      expect(mockService.sendTransactionalEmail).toHaveBeenCalledWith(
        'user@example.com',
        'Verify your account',
        'Click link to verify',
      );
      expect(result).toBe('msg-resend-999');
    });

    it('delegates processPendingNotifications to NotificationService and returns summary', async () => {
      const mockStats = { claimed: 5, sent: 4, failed: 1, deadLettered: 0 };

      const mockService = {
        requestNotification: vi.fn(),
        sendTransactionalEmail: vi.fn(),
        processPendingNotifications: vi.fn().mockResolvedValue(mockStats),
      } as unknown as NotificationService;

      const client: INotificationClient = new LocalNotificationClient(mockService);

      const result = await client.processPendingNotifications({
        batchSize: 25,
        baseRetryDelayMs: 500,
      });

      expect(mockService.processPendingNotifications).toHaveBeenCalledTimes(1);
      expect(mockService.processPendingNotifications).toHaveBeenCalledWith({
        batchSize: 25,
        baseRetryDelayMs: 500,
      });
      expect(result).toEqual(mockStats);
    });

    it('notificationModule.createClient returns an instance implementing INotificationClient', () => {
      const repo = new NotificationRepository();
      const emailProvider = new InMemoryEmailProvider();
      const smsProvider = new InMemorySmsProvider();
      const pushProvider = new InMemoryPushProvider();

      const service = new NotificationService(
        mockDb,
        repo,
        emailProvider,
        smsProvider,
        pushProvider,
        logger,
      );

      const client = notificationModule.createClient(service);

      expect(client).toBeInstanceOf(LocalNotificationClient);
      expect(typeof client.requestNotification).toBe('function');
      expect(typeof client.sendTransactionalEmail).toBe('function');
      expect(typeof client.processPendingNotifications).toBe('function');
    });
  });

  describe('External Callers Accept INotificationClient', () => {
    it('PriceAlertService accepts INotificationClient in constructor and calls requestNotification', async () => {
      const mockClient: INotificationClient = {
        requestNotification: vi.fn().mockResolvedValue({
          notificationId: 'notif-price-1',
          status: 'PENDING',
          channel: 'EMAIL',
          recipient: 'watcher@example.com',
          idempotencyKey: 'price-drop:prod-1:5000:PRICE_DROP_ALERT:watcher@example.com:EMAIL',
        }),
        sendTransactionalEmail: vi.fn(),
        processPendingNotifications: vi.fn(),
      };

      // Mock DB queries for PriceAlertService.checkProduct:
      // 1. currentFloorPrice (stocked listing)
      // 2. findAlertCandidates (watcher)
      // 3. productBasics (title)
      // 4. demandForecast
      // 5. markAlerted
      (mockDb.query as any)
        .mockResolvedValueOnce({
          rows: [{ price_amount: 5000, currency: 'USD' }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              customer_tenant_id: 'cust-tenant-1',
              product_id: 'prod-1',
              last_seen_price: 10000,
              last_seen_currency: 'USD',
              last_alerted_price: null,
              user_id: 'usr-1',
              email: 'watcher@example.com',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [{ title: 'Widget', brand: 'Acme', thumbnail_url: null }],
        })
        .mockResolvedValueOnce({
          rows: [], // demand forecast
        })
        .mockResolvedValueOnce({
          rows: [], // markAlerted
        });

      const priceAlertService = new PriceAlertService(
        mockDb,
        mockClient,
        logger,
        'http://localhost:3000',
      );

      const result = await priceAlertService.checkProduct('prod-1');

      expect(result.checked).toBe(true);
      expect(result.alertsSent).toBe(1);
      expect(mockClient.requestNotification).toHaveBeenCalledTimes(1);
      expect(mockClient.requestNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          notificationType: 'PRICE_DROP_ALERT',
          recipient: 'watcher@example.com',
          channel: 'EMAIL',
        }),
      );
    });

    it('BackInStockService accepts INotificationClient in constructor and calls requestNotification and processPendingNotifications', async () => {
      const mockClient: INotificationClient = {
        requestNotification: vi.fn().mockResolvedValue({
          notificationId: 'notif-stock-1',
          status: 'PENDING',
          channel: 'EMAIL',
          recipient: 'stockwatcher@example.com',
          idempotencyKey: 'back-in-stock:sub-1',
        }),
        sendTransactionalEmail: vi.fn(),
        processPendingNotifications: vi
          .fn()
          .mockResolvedValue({ claimed: 1, sent: 1, failed: 0, deadLettered: 0 }),
      };

      (mockDb.withTransaction as any).mockImplementation(async (cb: (tx: any) => Promise<any>) =>
        cb(mockDb),
      );

      (mockDb.query as any)
        .mockResolvedValueOnce({
          // findActiveSubscriptionsForProduct
          rows: [
            {
              id: 'sub-1',
              customer_id: 'usr-1',
              tenant_id: 'tenant-cust-1',
              product_id: 'prod-1',
              sku_id: 'sku-1',
              status: 'ACTIVE',
              email: 'stockwatcher@example.com',
              user_status: 'ACTIVE',
              email_verified_at: new Date(),
              product_title: 'Super Gizmo',
              product_thumbnail_url: 'http://img/gizmo.webp',
            },
          ],
        })
        .mockResolvedValueOnce({
          // verify status is still ACTIVE
          rows: [{ status: 'ACTIVE' }],
        })
        .mockResolvedValueOnce({
          // markSubscriptionNotified
          rows: [],
        });

      const backInStockService = new BackInStockService(
        mockDb,
        logger,
        mockClient,
        undefined,
        'http://localhost:3000',
      );

      const result = await backInStockService.processBackInStockNotification({
        productId: 'prod-1',
        skuId: 'sku-1',
        eventId: 'evt-inventory-available-1',
      });

      expect(result.notifiedCount).toBe(1);
      expect(mockClient.requestNotification).toHaveBeenCalledTimes(1);
      expect(mockClient.requestNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          notificationType: 'BACK_IN_STOCK_ALERT',
          recipient: 'stockwatcher@example.com',
          channel: 'EMAIL',
        }),
      );
      expect(mockClient.processPendingNotifications).toHaveBeenCalledTimes(1);
    });

    it('NotificationEventConsumer accepts INotificationClient and delegates requestNotification for domain events', async () => {
      const mockClient: INotificationClient = {
        requestNotification: vi.fn().mockResolvedValue({
          notificationId: 'notif-evt-1',
          status: 'PENDING',
          channel: 'EMAIL',
          recipient: 'buyer@example.com',
          idempotencyKey: 'evt-order-1:ORDER_CONFIRMATION:buyer@example.com:EMAIL',
        }),
        sendTransactionalEmail: vi.fn(),
        processPendingNotifications: vi.fn(),
      };

      const outboxRepo = new OutboxRepository();
      const transport = new InMemoryEventTransport();

      // Mock outboxRepo receipt operations on mockDb
      (mockDb.query as any).mockResolvedValue({ rows: [] });
      (mockDb.withTransaction as any).mockImplementation(async (cb: (tx: any) => Promise<any>) =>
        cb(mockDb),
      );

      const consumer = new NotificationEventConsumer(
        mockDb,
        outboxRepo,
        transport,
        logger,
        mockClient,
      );

      consumer.registerSubscriptions();

      const orderEvent = createDomainEvent({
        eventType: EventTypes.ORDER_CREATED,
        aggregateType: 'order',
        aggregateId: 'ord-100',
        tenantId: 'tenant-1',
        payload: {
          customerEmail: 'buyer@example.com',
          customerId: 'cust-1',
          totalAmount: '$99.00',
        },
      });

      await transport.publish(orderEvent);

      expect(mockClient.requestNotification).toHaveBeenCalledTimes(1);
      expect(mockClient.requestNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          customerId: 'cust-1',
          eventId: orderEvent.eventId,
          notificationType: 'ORDER_CONFIRMATION',
          channel: 'EMAIL',
          recipient: 'buyer@example.com',
          templateId: 'tpl_order_confirmation',
        }),
      );
    });

    it('NotificationEventConsumer dispatches requestNotification across all supported domain event types', async () => {
      const requestedTypes: string[] = [];
      const mockClient: INotificationClient = {
        requestNotification: vi.fn(async (input) => {
          requestedTypes.push(input.notificationType);
          return {
            notificationId: `notif-${input.notificationType}`,
            status: 'PENDING' as const,
            channel: input.channel,
            recipient: input.recipient,
            idempotencyKey: `${input.eventId}:${input.notificationType}`,
          };
        }),
        sendTransactionalEmail: vi.fn(),
        processPendingNotifications: vi.fn(),
      };

      const outboxRepo = new OutboxRepository();
      const transport = new InMemoryEventTransport();

      (mockDb.query as any).mockResolvedValue({ rows: [] });
      (mockDb.withTransaction as any).mockImplementation(async (cb: (tx: any) => Promise<any>) =>
        cb(mockDb),
      );

      const consumer = new NotificationEventConsumer(
        mockDb,
        outboxRepo,
        transport,
        logger,
        mockClient,
      );

      consumer.registerSubscriptions();

      // 1. PAYMENT_SUCCEEDED
      await transport.publish(
        createDomainEvent({
          eventType: EventTypes.PAYMENT_SUCCEEDED,
          aggregateType: 'payment_intent',
          aggregateId: 'pi-1',
          tenantId: 'tenant-1',
          payload: { customerEmail: 'buyer@example.com', amount: 50, currency: 'USD' },
        }),
      );

      // 2. PAYMENT_FAILED
      await transport.publish(
        createDomainEvent({
          eventType: EventTypes.PAYMENT_FAILED,
          aggregateType: 'payment_intent',
          aggregateId: 'pi-2',
          tenantId: 'tenant-1',
          payload: { customerEmail: 'buyer@example.com', amount: 50, reason: 'Card declined' },
        }),
      );

      // 3. FULFILLMENT_SHIPMENT_STATUS_CHANGED
      await transport.publish(
        createDomainEvent({
          eventType: EventTypes.FULFILLMENT_SHIPMENT_STATUS_CHANGED,
          aggregateType: 'shipment',
          aggregateId: 'ship-1',
          tenantId: 'tenant-1',
          payload: { customerEmail: 'buyer@example.com', status: 'IN_TRANSIT' },
        }),
      );

      // 4. FULFILLMENT_RETURN_STATUS_CHANGED
      await transport.publish(
        createDomainEvent({
          eventType: EventTypes.FULFILLMENT_RETURN_STATUS_CHANGED,
          aggregateType: 'return',
          aggregateId: 'ret-1',
          tenantId: 'tenant-1',
          payload: { customerEmail: 'buyer@example.com', status: 'APPROVED' },
        }),
      );

      // 5. SETTLEMENT_STATUS_CHANGED
      await transport.publish(
        createDomainEvent({
          eventType: EventTypes.SETTLEMENT_STATUS_CHANGED,
          aggregateType: 'settlement',
          aggregateId: 'stl-1',
          tenantId: 'tenant-1',
          payload: {
            merchantEmail: 'merchant@example.com',
            status: 'PAID',
            periodStart: '2026-01-01',
            periodEnd: '2026-01-31',
            netPayableAmount: '500.00',
            currency: 'USD',
          },
        }),
      );

      expect(requestedTypes).toEqual([
        'PAYMENT_RECEIPT',
        'PAYMENT_FAILURE_ALERT',
        'SHIPMENT_STATUS_UPDATE',
        'RETURN_STATUS_UPDATE',
        'SETTLEMENT_UPDATE',
      ]);
    });

    it('notificationModule.createConsumer accepts INotificationClient or NotificationService', () => {
      const transport = new InMemoryEventTransport();
      const mockClient: INotificationClient = {
        requestNotification: vi.fn(),
        sendTransactionalEmail: vi.fn(),
        processPendingNotifications: vi.fn(),
      };

      // 1. Direct INotificationClient
      const consumerWithClient = notificationModule.createConsumer(
        mockDb,
        transport,
        logger,
        mockClient,
      );
      expect(consumerWithClient).toBeInstanceOf(NotificationEventConsumer);

      // 2. Concrete NotificationService (auto-wrapped in LocalNotificationClient)
      const repo = new NotificationRepository();
      const service = new NotificationService(
        mockDb,
        repo,
        new InMemoryEmailProvider(),
        new InMemorySmsProvider(),
        new InMemoryPushProvider(),
        logger,
      );
      const consumerWithService = notificationModule.createConsumer(
        mockDb,
        transport,
        logger,
        service,
      );
      expect(consumerWithService).toBeInstanceOf(NotificationEventConsumer);
    });
  });
});
