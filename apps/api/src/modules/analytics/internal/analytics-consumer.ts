import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { DomainEvent, EventTransport } from '../../events/index.js';
import { EventTypes, BaseEventConsumer, OutboxRepository } from '../../events/index.js';
import type { AnalyticsService } from './analytics-service.js';

export class AnalyticsEventConsumer extends BaseEventConsumer {
  constructor(
    db: DatabaseConnection,
    outboxRepo: OutboxRepository,
    transport: EventTransport,
    logger: Logger,
    private readonly analyticsService: AnalyticsService,
  ) {
    super('analytics-ingestor', db, outboxRepo, transport, logger);
  }

  registerSubscriptions(): void {
    const events = [
      EventTypes.ORDER_CREATED,
      EventTypes.ORDER_STATUS_CHANGED,
      EventTypes.PAYMENT_SUCCEEDED,
      EventTypes.PAYMENT_FAILED,
      EventTypes.PAYMENT_REFUND_CREATED,
      EventTypes.FULFILLMENT_SHIPMENT_CREATED,
      EventTypes.FULFILLMENT_SHIPMENT_STATUS_CHANGED,
      EventTypes.FULFILLMENT_RETURN_STATUS_CHANGED,
      EventTypes.SETTLEMENT_STATUS_CHANGED,
      EventTypes.CATALOG_PRODUCT_CREATED,
      EventTypes.CATALOG_PRODUCT_UPDATED,
      EventTypes.CATALOG_PRODUCT_ARCHIVED,
      EventTypes.MARKETPLACE_LISTING_CREATED,
      EventTypes.MARKETPLACE_LISTING_UPDATED,
      EventTypes.MARKETPLACE_LISTING_DEACTIVATED,
    ];

    for (const evt of events) {
      this.transport.subscribe(evt, async (event) => {
        await this.process(event);
      });
    }
  }

  protected async handleEvent(event: DomainEvent): Promise<void> {
    await this.analyticsService.ingestEvent(event);
  }
}
