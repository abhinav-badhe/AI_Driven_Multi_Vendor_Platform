import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { SearchService } from '../../search/index.js';
import type { DomainEvent } from './event-envelope.js';
import { EventTypes } from './event-envelope.js';
import type { EventTransport } from './event-transport.js';
import { BaseEventConsumer } from './event-consumer.js';
import { OutboxRepository } from './outbox-repository.js';

export class SearchEventConsumer extends BaseEventConsumer {
  constructor(
    db: DatabaseConnection,
    outboxRepo: OutboxRepository,
    transport: EventTransport,
    logger: Logger,
    private readonly searchService: SearchService,
  ) {
    super('search-projector', db, outboxRepo, transport, logger);
  }

  registerSubscriptions(): void {
    const events = [
      EventTypes.CATALOG_PRODUCT_CREATED,
      EventTypes.CATALOG_PRODUCT_UPDATED,
      EventTypes.CATALOG_PRODUCT_ARCHIVED,
      EventTypes.MARKETPLACE_LISTING_CREATED,
      EventTypes.MARKETPLACE_LISTING_UPDATED,
      EventTypes.MARKETPLACE_LISTING_DEACTIVATED,
      EventTypes.INVENTORY_STOCK_CHANGED,
    ];

    for (const evt of events) {
      this.transport.subscribe(evt, async (event) => {
        await this.process(event);
      });
    }
  }

  protected async handleEvent(event: DomainEvent): Promise<void> {
    const payload = event.payload as Record<string, unknown>;

    switch (event.eventType) {
      case EventTypes.CATALOG_PRODUCT_CREATED:
      case EventTypes.CATALOG_PRODUCT_UPDATED: {
        const productId = (payload.productId as string) || event.aggregateId;
        // Prioritize authoritative synchronization from domain source; fallback to typed projection payload
        try {
          await this.searchService.syncProductFromAuthoritativeSource(productId);
        } catch {
          if (
            typeof payload.title === 'string' &&
            typeof payload.slug === 'string' &&
            typeof payload.sourceVersion === 'number'
          ) {
            await this.searchService.upsertProductProjection({
              productId,
              title: payload.title,
              slug: payload.slug,
              description: typeof payload.description === 'string' ? payload.description : null,
              brand: typeof payload.brand === 'string' ? payload.brand : null,
              categoryId: typeof payload.categoryId === 'string' ? payload.categoryId : null,
              categoryName: typeof payload.categoryName === 'string' ? payload.categoryName : null,
              status: (payload.status as 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED') ?? 'ACTIVE',
              attributes: (payload.attributes as Record<string, unknown>) ?? {},
              sourceVersion: payload.sourceVersion,
            });
          }
        }
        break;
      }

      case EventTypes.CATALOG_PRODUCT_ARCHIVED: {
        const productId = (payload.productId as string) || event.aggregateId;
        await this.searchService.removeProductProjection(productId);
        break;
      }

      case EventTypes.MARKETPLACE_LISTING_CREATED:
      case EventTypes.MARKETPLACE_LISTING_UPDATED: {
        const listingId = (payload.listingId as string) || event.aggregateId;
        try {
          await this.searchService.syncListingFromAuthoritativeSource(listingId);
        } catch {
          if (
            typeof payload.merchantId === 'string' &&
            typeof payload.productId === 'string' &&
            typeof payload.skuId === 'string' &&
            typeof payload.skuCode === 'string' &&
            typeof payload.priceAmount === 'number' &&
            typeof payload.currency === 'string' &&
            typeof payload.sourceVersion === 'number'
          ) {
            await this.searchService.upsertListingProjection({
              listingId,
              merchantId: payload.merchantId,
              merchantName:
                typeof payload.merchantName === 'string' ? payload.merchantName : undefined,
              productId: payload.productId,
              skuId: payload.skuId,
              skuCode: payload.skuCode,
              priceAmount: payload.priceAmount,
              currency: payload.currency,
              compareAtPrice:
                typeof payload.compareAtPrice === 'number' ? payload.compareAtPrice : null,
              status: (payload.status as 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'SUSPENDED') ?? 'ACTIVE',
              inStock: payload.inStock === true,
              availableQuantity:
                typeof payload.availableQuantity === 'number' ? payload.availableQuantity : 0,
              attributes: (payload.attributes as Record<string, unknown>) ?? {},
              sourceVersion: payload.sourceVersion,
            });
          }
        }
        break;
      }

      case EventTypes.MARKETPLACE_LISTING_DEACTIVATED: {
        const productId = payload.productId as string;
        const listingId = (payload.listingId as string) || event.aggregateId;
        if (productId && listingId) {
          await this.searchService.removeListingProjection(productId, listingId);
        }
        break;
      }

      case EventTypes.INVENTORY_STOCK_CHANGED: {
        const listingId = payload.listingId as string;
        const inStock = payload.isAvailable === true;
        const availableQuantity =
          typeof payload.availableQuantity === 'number' ? payload.availableQuantity : 0;
        const sourceVersion =
          typeof payload.sourceVersion === 'number'
            ? payload.sourceVersion
            : new Date(event.occurredAt).getTime();

        if (listingId) {
          await this.searchService.updateOfferAvailability({
            listingId,
            inStock,
            availableQuantity,
            sourceVersion,
          });
        }
        break;
      }

      default:
        this.logger.warn('Search consumer received unhandled event type', {
          eventType: event.eventType,
          eventId: event.eventId,
        });
    }
  }
}
