import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { DomainEvent, EventTransport } from '../../events/index.js';
import { EventTypes, BaseEventConsumer, OutboxRepository } from '../../events/index.js';
import type { BackInStockService } from './back-in-stock-service.js';

export class BackInStockEventConsumer extends BaseEventConsumer {
  constructor(
    db: DatabaseConnection,
    outboxRepo: OutboxRepository,
    transport: EventTransport,
    logger: Logger,
    private readonly backInStockService: BackInStockService,
  ) {
    super('back-in-stock-dispatcher', db, outboxRepo, transport, logger);
  }

  registerSubscriptions(): void {
    const events = [EventTypes.INVENTORY_STOCK_AVAILABLE];

    for (const evt of events) {
      this.transport.subscribe(evt, async (event) => {
        await this.process(event);
      });
    }
  }

  protected async handleEvent(event: DomainEvent): Promise<void> {
    if (event.eventType !== EventTypes.INVENTORY_STOCK_AVAILABLE) {
      return;
    }

    const payload = event.payload as Record<string, unknown>;
    const isAvailable = Boolean(payload.isAvailable ?? Number(payload.availableQuantity ?? 0) > 0);

    // Only process when stock actually transitioned to available
    if (!isAvailable) {
      return;
    }

    const skuId = (payload.skuId as string) || undefined;
    let productId = (payload.productId as string) || undefined;

    // Resolve productId if not directly supplied in the payload
    if (!productId && skuId) {
      try {
        const skuRes = await this.db.query<{ product_id: string }>(
          'SELECT product_id FROM product_skus WHERE id = $1',
          [skuId],
        );
        productId = skuRes.rows[0]?.product_id;
      } catch {
        // non-blocking
      }
    }

    if (!productId && payload.listingId) {
      try {
        const listingRes = await this.db.query<{ product_id: string }>(
          `SELECT s.product_id 
           FROM merchant_listings l 
           JOIN product_skus s ON s.id = l.sku_id 
           WHERE l.id = $1`,
          [payload.listingId],
        );
        productId = listingRes.rows[0]?.product_id;
      } catch {
        // non-blocking
      }
    }

    if (!productId) {
      this.logger.warn('Could not resolve productId for inventory event in BackInStockConsumer', {
        eventId: event.eventId,
        skuId,
        listingId: payload.listingId,
      });
      return;
    }

    await this.backInStockService.processBackInStockNotification({
      productId,
      skuId,
      eventId: event.eventId,
    });
  }
}
