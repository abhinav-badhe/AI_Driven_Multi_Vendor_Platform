import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { DomainEvent, EventTransport } from '../../events/index.js';
import { EventTypes, BaseEventConsumer, OutboxRepository } from '../../events/index.js';
import type { INotificationClient } from './notification-client.js';

export class NotificationEventConsumer extends BaseEventConsumer {
  constructor(
    db: DatabaseConnection,
    outboxRepo: OutboxRepository,
    transport: EventTransport,
    logger: Logger,
    private readonly notificationClient: INotificationClient,
  ) {
    super('notification-dispatcher', db, outboxRepo, transport, logger);
  }

  registerSubscriptions(): void {
    const events = [
      EventTypes.ORDER_CREATED,
      EventTypes.PAYMENT_SUCCEEDED,
      EventTypes.PAYMENT_FAILED,
      EventTypes.FULFILLMENT_SHIPMENT_STATUS_CHANGED,
      EventTypes.FULFILLMENT_RETURN_STATUS_CHANGED,
      EventTypes.SETTLEMENT_STATUS_CHANGED,
    ];

    for (const evt of events) {
      this.transport.subscribe(evt, async (event) => {
        await this.process(event);
      });
    }
  }

  protected async handleEvent(event: DomainEvent): Promise<void> {
    const payload = event.payload as Record<string, unknown>;
    const tenantId = event.tenantId;

    switch (event.eventType) {
      case EventTypes.ORDER_CREATED: {
        const customerId = payload.customerId as string | undefined;
        const customerEmail = await this.resolveCustomerEmail(payload, customerId);
        if (customerEmail) {
          await this.notificationClient.requestNotification({
            tenantId,
            customerId,
            eventId: event.eventId,
            notificationType: 'ORDER_CONFIRMATION',
            channel: 'EMAIL',
            recipient: customerEmail,
            templateId: 'tpl_order_confirmation',
            payload: {
              subject: `Order Confirmed: #${event.aggregateId}`,
              body: `Thank you for your order! Your order #${event.aggregateId} has been confirmed. Total: ${payload.totalAmount ?? 'N/A'}.`,
              orderId: event.aggregateId,
              ...payload,
            },
          });
        }
        break;
      }

      case EventTypes.PAYMENT_SUCCEEDED: {
        const customerId = payload.customerId as string | undefined;
        const customerEmail = await this.resolveCustomerEmail(payload, customerId);
        if (customerEmail) {
          await this.notificationClient.requestNotification({
            tenantId,
            customerId,
            eventId: event.eventId,
            notificationType: 'PAYMENT_RECEIPT',
            channel: 'EMAIL',
            recipient: customerEmail,
            templateId: 'tpl_payment_receipt',
            payload: {
              subject: `Payment Receipt for Intent #${event.aggregateId}`,
              body: `We have received your payment of ${payload.amount} ${payload.currency}.`,
              paymentIntentId: event.aggregateId,
              ...payload,
            },
          });
        }
        break;
      }

      case EventTypes.PAYMENT_FAILED: {
        const customerId = payload.customerId as string | undefined;
        const customerEmail = await this.resolveCustomerEmail(payload, customerId);
        if (customerEmail) {
          await this.notificationClient.requestNotification({
            tenantId,
            customerId,
            eventId: event.eventId,
            notificationType: 'PAYMENT_FAILURE_ALERT',
            channel: 'EMAIL',
            recipient: customerEmail,
            templateId: 'tpl_payment_failure',
            payload: {
              subject: `Payment Failed for Order #${payload.orderId ?? event.aggregateId}`,
              body: `Your payment of ${payload.amount} could not be processed: ${payload.reason ?? 'Declined by bank'}.`,
              paymentIntentId: event.aggregateId,
              ...payload,
            },
          });
        }
        break;
      }

      case EventTypes.FULFILLMENT_SHIPMENT_STATUS_CHANGED: {
        const customerId = payload.customerId as string | undefined;
        const customerEmail = await this.resolveCustomerEmail(payload, customerId);
        if (customerEmail) {
          await this.notificationClient.requestNotification({
            tenantId,
            customerId,
            eventId: event.eventId,
            notificationType: 'SHIPMENT_STATUS_UPDATE',
            channel: 'EMAIL',
            recipient: customerEmail,
            templateId: 'tpl_shipment_status',
            payload: {
              subject: `Shipment Status Updated: ${payload.status ?? payload.newStatus ?? 'UPDATED'}`,
              body: `Shipment #${event.aggregateId} status has changed to ${payload.status ?? payload.newStatus ?? 'UPDATED'}. Tracking number: ${payload.trackingNumber ?? 'Pending'}.`,
              shipmentId: event.aggregateId,
              ...payload,
            },
          });
        }
        break;
      }

      case EventTypes.FULFILLMENT_RETURN_STATUS_CHANGED: {
        const customerId = payload.customerId as string | undefined;
        const customerEmail = await this.resolveCustomerEmail(payload, customerId);
        if (customerEmail) {
          const statusText = (payload.status ?? payload.newStatus ?? 'UPDATED') as string;
          await this.notificationClient.requestNotification({
            tenantId,
            customerId,
            eventId: event.eventId,
            notificationType: 'RETURN_STATUS_UPDATE',
            channel: 'EMAIL',
            recipient: customerEmail,
            templateId: 'tpl_return_status',
            payload: {
              subject: `Return Request Status: ${statusText}`,
              body: `Return request #${event.aggregateId} status has changed to ${statusText}.`,
              returnId: event.aggregateId,
              ...payload,
            },
          });
        }
        break;
      }

      case EventTypes.SETTLEMENT_STATUS_CHANGED: {
        const merchantEmail = await this.resolveMerchantEmail(payload, tenantId);
        if (merchantEmail) {
          await this.notificationClient.requestNotification({
            tenantId,
            eventId: event.eventId,
            notificationType: 'SETTLEMENT_UPDATE',
            channel: 'EMAIL',
            recipient: merchantEmail,
            templateId: 'tpl_settlement_update',
            payload: {
              subject: `Settlement Update: ${payload.status}`,
              body: `Your settlement #${event.aggregateId} for period ${payload.periodStart} - ${payload.periodEnd} is now ${payload.status}. Net payable: ${payload.netPayableAmount} ${payload.currency}.`,
              settlementId: event.aggregateId,
              ...payload,
            },
          });
        }
        break;
      }

      default:
        this.logger.warn('Notification consumer received unhandled event type', {
          eventType: event.eventType,
          eventId: event.eventId,
        });
    }
  }

  private async resolveCustomerEmail(
    payload: Record<string, unknown>,
    customerId?: string,
  ): Promise<string | undefined> {
    const direct = (payload.customerEmail ?? payload.recipientEmail ?? payload.email) as string | undefined;
    if (typeof direct === 'string' && direct.includes('@')) {
      return direct;
    }

    if (customerId) {
      try {
        const res = await this.db.query<{ email: string }>(
          `SELECT u.email FROM users u
           LEFT JOIN tenant_memberships tm ON tm.user_id = u.id
           WHERE tm.tenant_id = $1 OR u.id = $1
           LIMIT 1`,
          [customerId],
        );
        if (res.rows[0]?.email) return res.rows[0].email;
      } catch (err) {
        this.logger.warn('Failed to resolve customer email by customerId', { customerId, error: String(err) });
      }
    }

    const orderId = (payload.customerOrderId ?? payload.orderId) as string | undefined;
    if (orderId) {
      try {
        const res = await this.db.query<{ email: string }>(
          `SELECT u.email FROM users u
           JOIN tenant_memberships tm ON tm.user_id = u.id
           JOIN customer_orders co ON co.customer_tenant_id = tm.tenant_id
           WHERE co.id = $1
           LIMIT 1`,
          [orderId],
        );
        if (res.rows[0]?.email) return res.rows[0].email;
      } catch (err) {
        this.logger.warn('Failed to resolve customer email by orderId', { orderId, error: String(err) });
      }
    }

    return undefined;
  }

  private async resolveMerchantEmail(
    payload: Record<string, unknown>,
    merchantTenantId?: string,
  ): Promise<string | undefined> {
    const direct = (payload.merchantEmail ?? payload.email) as string | undefined;
    if (typeof direct === 'string' && direct.includes('@')) {
      return direct;
    }

    if (merchantTenantId) {
      try {
        const res = await this.db.query<{ email: string }>(
          `SELECT u.email FROM users u
           JOIN tenant_memberships tm ON tm.user_id = u.id
           WHERE tm.tenant_id = $1
           LIMIT 1`,
          [merchantTenantId],
        );
        if (res.rows[0]?.email) return res.rows[0].email;
      } catch (err) {
        this.logger.warn('Failed to resolve merchant email', { merchantTenantId, error: String(err) });
      }
    }

    return undefined;
  }
}
