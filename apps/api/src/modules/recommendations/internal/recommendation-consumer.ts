import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { DomainEvent, EventTransport } from '../../events/index.js';
import { EventTypes, BaseEventConsumer, OutboxRepository } from '../../events/index.js';
import type { RecommendationService } from './recommendation-service.js';

export class RecommendationEventConsumer extends BaseEventConsumer {
  constructor(
    db: DatabaseConnection,
    outboxRepo: OutboxRepository,
    transport: EventTransport,
    logger: Logger,
    private readonly recommendationService: RecommendationService,
  ) {
    super('recommendations-ingestor', db, outboxRepo, transport, logger);
  }

  registerSubscriptions(): void {
    const events = [
      EventTypes.CATALOG_PRODUCT_ARCHIVED,
      EventTypes.CATALOG_PRODUCT_UPDATED,
      EventTypes.MARKETPLACE_LISTING_DEACTIVATED,
      EventTypes.ORDER_CREATED,
    ];

    for (const evt of events) {
      this.transport.subscribe(evt, async (event) => {
        await this.process(event);
      });
    }
  }

  protected async handleEvent(event: DomainEvent): Promise<void> {
    switch (event.eventType) {
      case EventTypes.CATALOG_PRODUCT_ARCHIVED: {
        const productId = event.aggregateId;
        const tenantId = event.tenantId;
        if (productId && tenantId) {
          await this.recommendationService.invalidateProduct(tenantId, productId);
          this.logger.info(`Invalidated recommendations for archived product ${productId}`, {
            productId,
            tenantId,
            eventId: event.eventId,
          });
        }
        break;
      }

      case EventTypes.CATALOG_PRODUCT_UPDATED:
      case EventTypes.MARKETPLACE_LISTING_DEACTIVATED:
      case EventTypes.ORDER_CREATED: {
        // Event received, acknowledged, and triggers cache freshness handling
        this.logger.info(`Processed recommendation trigger event ${event.eventType}`, {
          eventId: event.eventId,
          eventType: event.eventType,
          tenantId: event.tenantId,
        });
        break;
      }

      default:
        break;
    }
  }
}
