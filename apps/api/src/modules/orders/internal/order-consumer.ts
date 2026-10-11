import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { OrderService } from './order-service.js';
import type { IOrderService } from './order-models.js';
import type { DomainEvent, EventTransport } from '../../events/index.js';
import { EventTypes, BaseEventConsumer, OutboxRepository } from '../../events/index.js';
import type { AuthorizedActor } from '../../identity/rbac/policy.js';

export class OrderEventConsumer extends BaseEventConsumer {
  constructor(
    db: DatabaseConnection,
    outboxRepo: OutboxRepository,
    transport: EventTransport,
    logger: Logger,
    private readonly orderService: IOrderService | OrderService,
  ) {
    super('order-processor', db, outboxRepo, transport, logger);
  }

  registerSubscriptions(): void {
    this.transport.subscribe(EventTypes.PAYMENT_SUCCEEDED, async (event) => {
      await this.process(event);
    });
  }

  protected async handleEvent(event: DomainEvent): Promise<void> {
    const payload = event.payload as Record<string, unknown>;

    if (event.eventType === EventTypes.PAYMENT_SUCCEEDED) {
      const checkoutSessionId = payload.checkoutSessionId as string;
      const paymentIntentId = event.aggregateId;
      const idempotencyKey = event.eventId; // Use the event ID to guarantee idempotency

      if (!checkoutSessionId || !paymentIntentId) {
        this.logger.error('PAYMENT_SUCCEEDED event missing checkoutSessionId or paymentIntentId', {
          eventId: event.eventId,
        });
        return;
      }

      const actor: AuthorizedActor = {
        userId: 'system-order-consumer',
        tenantId: event.tenantId, // Execute within the customer's tenant context
        role: 'CUSTOMER', // Needed to pass order:create-own permission
      };

      try {
        await this.orderService.createOrderFromCheckout(actor, {
          checkoutSessionId,
          paymentIntentId,
          idempotencyKey,
        });
        this.logger.info('Order created successfully from payment event', {
          paymentIntentId,
          checkoutSessionId,
          eventId: event.eventId,
        });
      } catch (err: unknown) {
        // Validation errors might occur if the order was already processed manually,
        // which is expected due to concurrent POST /orders and webhook.
        if (err instanceof Error && err.name === 'ValidationError' && err.message.includes('idempotency key')) {
           this.logger.info('Order creation skipped due to idempotency', {
             paymentIntentId,
             checkoutSessionId,
             eventId: event.eventId,
           });
           return;
        }
        
        // Log error but rethrow so the consumer retry mechanism works if it's a transient failure
        this.logger.error('Failed to create order from payment event', {
          paymentIntentId,
          checkoutSessionId,
          eventId: event.eventId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }
  }
}
