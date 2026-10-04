import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { DomainEvent, EventTransport } from '../../events/index.js';
import { EventTypes, BaseEventConsumer, OutboxRepository } from '../../events/index.js';
import type { NotificationService } from './notification-service.js';

export class NotificationEventConsumer extends BaseEventConsumer {
  constructor(
    db: DatabaseConnection,
    outboxRepo: OutboxRepository,
    transport: EventTransport,
    logger: Logger,
    private readonly notificationService: NotificationService,
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
        const customerEmail = payload.customerEmail as string | undefined;
        const customerId = payload.customerId as string | undefined;
        if (customerEmail) {
          await this.notificationService.requestNotification({
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
        const customerEmail = payload.customerEmail as string | undefined;
        const customerId = payload.customerId as string | undefined;
        if (customerEmail) {
          await this.notificationService.requestNotification({
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
        const customerEmail = payload.customerEmail as string | undefined;
        const customerId = payload.customerId as string | undefined;
        if (customerEmail) {
          await this.notificationService.requestNotification({
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
        const customerEmail = payload.customerEmail as string | undefined;
        const customerId = payload.customerId as string | undefined;
        if (customerEmail) {
          await this.notificationService.requestNotification({
            tenantId,
            customerId,
            eventId: event.eventId,
            notificationType: 'SHIPMENT_STATUS_UPDATE',
            channel: 'EMAIL',
            recipient: customerEmail,
            templateId: 'tpl_shipment_status',
            payload: {
              subject: `Shipment Status Updated: ${payload.status}`,
              body: `Shipment #${event.aggregateId} status has changed to ${payload.status}. Tracking number: ${payload.trackingNumber ?? 'Pending'}.`,
              shipmentId: event.aggregateId,
              ...payload,
            },
          });
        }
        break;
      }

      case EventTypes.FULFILLMENT_RETURN_STATUS_CHANGED: {
        const customerEmail = payload.customerEmail as string | undefined;
        const customerId = payload.customerId as string | undefined;
        if (customerEmail) {
          await this.notificationService.requestNotification({
            tenantId,
            customerId,
            eventId: event.eventId,
            notificationType: 'RETURN_STATUS_UPDATE',
            channel: 'EMAIL',
            recipient: customerEmail,
            templateId: 'tpl_return_status',
            payload: {
              subject: `Return Request Status: ${payload.status}`,
              body: `Return request #${event.aggregateId} status has changed to ${payload.status}.`,
              returnId: event.aggregateId,
              ...payload,
            },
          });
        }
        break;
      }

      case EventTypes.SETTLEMENT_STATUS_CHANGED: {
        const merchantEmail = payload.merchantEmail as string | undefined;
        if (merchantEmail) {
          await this.notificationService.requestNotification({
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
}
