import { ConsumerProcessResult, DomainEvent, NotificationEventTypes } from './event-models.js';
import { NotificationService } from '../domain/notification-service.js';
import {
  NotificationRepository,
  DEFAULT_CONSUMER_RECEIPT_STALE_TIMEOUT_MS,
} from '../repository/notification-repository.js';

export interface EventConsumerLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export interface EventConsumerOptions {
  staleTimeoutMs?: number;
}

export interface ConsumerExecutionResult {
  handled: boolean;
  duplicate: boolean;
  error?: string;
}

const defaultLogger: EventConsumerLogger = {
  info: (msg, ctx) => console.log(`[INFO] ${msg}`, ctx ?? ''),
  warn: (msg, ctx) => console.warn(`[WARN] ${msg}`, ctx ?? ''),
  error: (msg, ctx) => console.error(`[ERROR] ${msg}`, ctx ?? ''),
};

export function sanitizeErrorMessage(rawMessage: string): string {
  if (!rawMessage || typeof rawMessage !== 'string') {
    return 'Event processing failed';
  }
  let sanitized = rawMessage;
  sanitized = sanitized.replace(/(authorization|bearer)\s+[a-zA-Z0-9_\-\.]+/gi, '$1 [REDACTED]');
  const sensitiveWords = [
    'password',
    'password_hash',
    'refreshtoken',
    'refresh_token',
    'accesstoken',
    'access_token',
    'token',
    'secret',
    'apikey',
    'api_key',
    'cardnumber',
    'card_number',
    'cvv',
    'cvc',
  ];
  for (const word of sensitiveWords) {
    const regex = new RegExp(`(["']?${word}["']?\\s*[:=]\\s*)(["']?[^"',;\\s}]+["']?)`, 'gi');
    sanitized = sanitized.replace(regex, '$1"[REDACTED]"');
  }
  return sanitized.slice(0, 500);
}

export class NotificationEventConsumer {
  private readonly consumerName = 'notification-dispatcher';
  private readonly staleTimeoutMs: number;

  constructor(
    private readonly notificationService: NotificationService,
    private readonly repository: NotificationRepository,
    private readonly logger: EventConsumerLogger = defaultLogger,
    options?: EventConsumerOptions,
  ) {
    this.staleTimeoutMs = options?.staleTimeoutMs ?? DEFAULT_CONSUMER_RECEIPT_STALE_TIMEOUT_MS;
  }

  /**
   * Processes a domain event through a reliable durable receipt lifecycle:
   * 1. Acquires a durable processing claim ('PROCESSING') before calling handleEvent.
   * 2. Prevents concurrent duplicate executions via database unique constraint.
   * 3. On success: records terminal 'COMPLETED' status with metadata preservation.
   * 4. On failure: records 'FAILED' status with safe error metadata so retry is permitted.
   * 5. On stale claim (prior worker crashed): safely reclaims after staleTimeoutMs.
   * 6. Fencing rule: if claim token is superseded, worker yields without overwriting newer owner.
   */
  async processEvent(event: DomainEvent): Promise<ConsumerProcessResult> {
    const claim = await this.repository.claimEventReceipt(this.consumerName, event.eventId, {
      staleTimeoutMs: this.staleTimeoutMs,
    });

    if (!claim.claimed) {
      if (claim.reason === 'ALREADY_COMPLETED') {
        this.logger.info('Event already processed by consumer, skipping', {
          consumerName: this.consumerName,
          eventId: event.eventId,
          eventType: event.eventType,
          correlationId: event.metadata?.correlationId,
          causationId: event.metadata?.causationId,
        });
        return { status: 'ALREADY_COMPLETED', eventId: event.eventId };
      } else {
        this.logger.info('Event currently being processed by concurrent or recent worker, skipping', {
          consumerName: this.consumerName,
          eventId: event.eventId,
          eventType: event.eventType,
          correlationId: event.metadata?.correlationId,
          causationId: event.metadata?.causationId,
        });
        return { status: 'CURRENTLY_PROCESSING', eventId: event.eventId };
      }
    }

    const claimToken = claim.claimToken;

    try {
      await this.handleEvent(event);

      const updated = await this.repository.updateReceiptStatus(
        this.consumerName,
        event.eventId,
        'COMPLETED',
        event.metadata ? { metadata: event.metadata, completedAt: new Date().toISOString() } : null,
        claimToken,
      );

      if (!updated) {
        this.logger.warn('Event completed by consumer but receipt was superseded by newer claim', {
          consumerName: this.consumerName,
          eventId: event.eventId,
          correlationId: event.metadata?.correlationId,
        });
        return {
          status: 'FAILED',
          eventId: event.eventId,
          error: 'Event processing claim was superseded by another worker',
        };
      }

      this.logger.info('Event successfully processed by consumer', {
        consumerName: this.consumerName,
        eventId: event.eventId,
        eventType: event.eventType,
        tenantId: event.tenantId,
        correlationId: event.metadata?.correlationId,
        causationId: event.metadata?.causationId,
        actorId: event.metadata?.actorId,
        source: event.metadata?.source,
      });

      return { status: 'PROCESSED', eventId: event.eventId };
    } catch (err: unknown) {
      const rawErrorMessage = err instanceof Error ? err.message : String(err);
      const safeError = sanitizeErrorMessage(rawErrorMessage);

      const updated = await this.repository.updateReceiptStatus(
        this.consumerName,
        event.eventId,
        'FAILED',
        {
          error: safeError,
          failedAt: new Date().toISOString(),
          eventType: event.eventType,
          ...(event.metadata ? { metadata: event.metadata } : {}),
        },
        claimToken,
      );

      if (!updated) {
        this.logger.warn('Consumer handler failed and receipt claim was superseded by another worker', {
          consumerName: this.consumerName,
          eventId: event.eventId,
          error: safeError,
        });
      } else {
        this.logger.error('Consumer event handler failed', {
          consumerName: this.consumerName,
          eventId: event.eventId,
          eventType: event.eventType,
          error: safeError,
          correlationId: event.metadata?.correlationId,
          causationId: event.metadata?.causationId,
          actorId: event.metadata?.actorId,
          source: event.metadata?.source,
        });
      }

      return {
        status: 'FAILED',
        eventId: event.eventId,
        error: safeError,
      };
    }
  }

  async process(event: DomainEvent): Promise<ConsumerProcessResult> {
    return this.processEvent(event);
  }

  protected async handleEvent(event: DomainEvent): Promise<void> {
    const payload = event.payload as Record<string, unknown>;
    const tenantId = event.tenantId;

    switch (event.eventType) {
      case NotificationEventTypes.ORDER_CREATED: {
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

      case NotificationEventTypes.PAYMENT_SUCCEEDED: {
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

      case NotificationEventTypes.PAYMENT_FAILED: {
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

      case NotificationEventTypes.FULFILLMENT_SHIPMENT_STATUS_CHANGED: {
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
              subject: `Shipment Status Updated: ${payload.status ?? payload.newStatus ?? 'UPDATED'}`,
              body: `Shipment #${event.aggregateId} status has changed to ${payload.status ?? payload.newStatus ?? 'UPDATED'}. Tracking number: ${payload.trackingNumber ?? 'Pending'}.`,
              shipmentId: event.aggregateId,
              ...payload,
            },
          });
        }
        break;
      }

      case NotificationEventTypes.FULFILLMENT_RETURN_STATUS_CHANGED: {
        const customerEmail = payload.customerEmail as string | undefined;
        const customerId = payload.customerId as string | undefined;
        if (customerEmail) {
          const statusText = (payload.status ?? payload.newStatus ?? 'UPDATED') as string;
          await this.notificationService.requestNotification({
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

      case NotificationEventTypes.SETTLEMENT_STATUS_CHANGED: {
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
