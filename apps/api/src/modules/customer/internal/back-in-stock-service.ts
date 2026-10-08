import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { AuthorizedActor } from '../../identity/index.js';
import { RbacPolicy } from '../../identity/rbac/policy.js';
import { NotFoundError, ValidationError } from '../../../errors/app-error.js';
import type { OutboxService } from '../../events/index.js';
import { createDomainEvent, EventTypes } from '../../events/index.js';
import type { NotificationService } from '../../notifications/index.js';
import { BackInStockRepository } from './back-in-stock-repository.js';
import type {
  BackInStockCheckResultDto,
  BackInStockSubscriptionDto,
  CreateBackInStockInput,
} from './back-in-stock-models.js';

export class BackInStockService {
  private readonly repo: BackInStockRepository;

  constructor(
    private readonly db: DatabaseConnection,
    private readonly logger: Logger,
    private readonly notificationService?: NotificationService | undefined,
    private readonly outboxService?: OutboxService | undefined,
    private readonly frontendUrl: string = 'http://localhost:3000',
  ) {
    this.repo = new BackInStockRepository();
  }

  async subscribe(
    actor: AuthorizedActor,
    input: CreateBackInStockInput,
  ): Promise<BackInStockSubscriptionDto> {
    RbacPolicy.requirePermission(actor, 'back-in-stock:write-own');

    const productId = input.productId?.trim();
    if (!productId) {
      throw new ValidationError('productId is required');
    }

    const skuId = input.skuId?.trim() || undefined;

    // 1. Validate Product existence
    const product = await this.repo.validateProduct(this.db, productId);
    if (!product) {
      throw new NotFoundError(`Product '${productId}' not found`);
    }

    // 2. Validate SKU if supplied
    if (skuId) {
      const skuValid = await this.repo.validateSkuBelongsToProduct(
        this.db,
        productId,
        skuId,
      );
      if (!skuValid) {
        throw new ValidationError(
          `SKU '${skuId}' does not belong to product '${productId}'`,
        );
      }
    }

    // 3. Eligibility Check: Cannot subscribe if product/SKU is currently in stock
    const availability = await this.repo.checkAvailability(
      this.db,
      productId,
      skuId,
    );
    if (availability.isAvailable) {
      throw new ValidationError(
        'Product is currently in stock. Notification subscription is unnecessary.',
        { code: 'ITEM_ALREADY_IN_STOCK' },
      );
    }

    // 4. Idempotently insert or reactivate subscription
    return await this.db.withTransaction(async (tx) => {
      const row = await this.repo.upsertSubscription(tx, {
        id: randomUUID(),
        customerId: actor.userId,
        tenantId: actor.tenantId,
        productId,
        skuId,
      });

      // 5. Transactional outbox event
      if (this.outboxService) {
        const event = createDomainEvent({
          eventType: EventTypes.BACK_IN_STOCK_SUBSCRIBED,
          eventVersion: 1,
          aggregateType: 'BackInStockSubscription',
          aggregateId: row.id,
          tenantId: actor.tenantId,
          payload: {
            subscriptionId: row.id,
            customerId: actor.userId,
            productId,
            skuId: row.sku_id,
            subscribedAt: row.created_at,
          },
          metadata: {
            actorId: actor.userId,
            source: 'back-in-stock-service',
          },
        });
        await this.outboxService.recordEvent(tx, event);
      }

      this.logger.info('Customer subscribed for back-in-stock notification', {
        subscriptionId: row.id,
        customerId: actor.userId,
        productId,
        skuId: row.sku_id,
      });

      return {
        id: row.id,
        customerId: row.customer_id,
        tenantId: row.tenant_id,
        productId: row.product_id,
        skuId: row.sku_id,
        status: row.status,
        product: {
          id: product.id,
          title: product.title,
          slug: product.id,
          brand: null,
          thumbnailUrl: null,
          status: product.status,
        },
        availability,
        createdAt: new Date(row.created_at).toISOString(),
        notifiedAt: row.notified_at ? new Date(row.notified_at).toISOString() : null,
        updatedAt: new Date(row.updated_at).toISOString(),
      };
    });
  }

  async cancelSubscription(
    actor: AuthorizedActor,
    productId: string,
  ): Promise<{ cancelled: boolean }> {
    RbacPolicy.requirePermission(actor, 'back-in-stock:write-own');

    const cleanProductId = productId?.trim();
    if (!cleanProductId) {
      throw new ValidationError('productId is required');
    }

    return await this.db.withTransaction(async (tx) => {
      const cancelled = await this.repo.cancelSubscription(
        tx,
        actor.userId,
        actor.tenantId,
        cleanProductId,
      );

      if (cancelled && this.outboxService) {
        const event = createDomainEvent({
          eventType: EventTypes.BACK_IN_STOCK_UNSUBSCRIBED,
          eventVersion: 1,
          aggregateType: 'BackInStockSubscription',
          aggregateId: cancelled.id,
          tenantId: actor.tenantId,
          payload: {
            subscriptionId: cancelled.id,
            customerId: actor.userId,
            productId: cleanProductId,
            cancelledAt: cancelled.updated_at,
          },
          metadata: {
            actorId: actor.userId,
            source: 'back-in-stock-service',
          },
        });
        await this.outboxService.recordEvent(tx, event);
      }

      return { cancelled: Boolean(cancelled) };
    });
  }

  async checkSubscription(
    actor: AuthorizedActor,
    productId: string,
  ): Promise<BackInStockCheckResultDto> {
    RbacPolicy.requirePermission(actor, 'back-in-stock:read-own');

    const cleanProductId = productId?.trim();
    if (!cleanProductId) {
      throw new ValidationError('productId is required');
    }

    const sub = await this.repo.findSubscription(
      this.db,
      actor.userId,
      actor.tenantId,
      cleanProductId,
    );

    return {
      isSubscribed: sub?.status === 'ACTIVE',
      subscriptionId: sub?.id ?? null,
      status: sub?.status ?? null,
    };
  }

  async listSubscriptions(
    actor: AuthorizedActor,
  ): Promise<BackInStockSubscriptionDto[]> {
    RbacPolicy.requirePermission(actor, 'back-in-stock:read-own');

    const rows = await this.repo.listSubscriptions(
      this.db,
      actor.userId,
      actor.tenantId,
    );

    const results: BackInStockSubscriptionDto[] = [];
    for (const r of rows) {
      const availability = await this.repo.checkAvailability(
        this.db,
        r.product_id,
        r.sku_id,
      );

      results.push({
        id: r.id,
        customerId: r.customer_id,
        tenantId: r.tenant_id,
        productId: r.product_id,
        skuId: r.sku_id,
        status: r.status,
        product: {
          id: r.product_id,
          title: r.product_title,
          slug: r.product_slug,
          brand: r.product_brand,
          thumbnailUrl: r.product_thumbnail_url,
          status: r.product_status,
        },
        sku: r.sku_id
          ? {
              id: r.sku_id,
              skuCode: r.sku_code ?? r.sku_id,
              attributes: r.sku_attributes ?? {},
            }
          : null,
        availability,
        createdAt: new Date(r.created_at).toISOString(),
        notifiedAt: r.notified_at ? new Date(r.notified_at).toISOString() : null,
        updatedAt: new Date(r.updated_at).toISOString(),
      });
    }

    return results;
  }

  /**
   * Processes active subscriptions when a product/SKU becomes available.
   * Concurrency-safe, transactional, only marks subscription NOTIFIED upon successful delivery.
   */
  async processBackInStockNotification(input: {
    productId: string;
    skuId?: string | undefined;
    eventId?: string | undefined;
  }): Promise<{ processedCount: number; notifiedCount: number }> {
    const { productId, skuId } = input;

    const subscriptions = await this.repo.findActiveSubscriptionsForProduct(
      this.db,
      productId,
      skuId,
    );

    if (subscriptions.length === 0) {
      return { processedCount: 0, notifiedCount: 0 };
    }

    let notifiedCount = 0;

    for (const sub of subscriptions) {
      // 1. Verify status is still ACTIVE
      const currentSub = await this.db.query<{ status: string }>(
        'SELECT status FROM back_in_stock_subscriptions WHERE id = $1',
        [sub.id],
      );
      if (currentSub.rows[0]?.status !== 'ACTIVE') {
        continue;
      }

      const subject = `Back in Stock: ${sub.product_title}`;
      const body = `Great news! "${sub.product_title}" is now back in stock and available for order.\n\nView and order here: ${this.frontendUrl.replace(/\/$/, '')}/product/${sub.product_id}`;

      // 2. Deliver notification through NotificationService abstraction (performed outside transaction)
      if (this.notificationService) {
        // Idempotency invariant: Tie the notification event identifier deterministically
        // to the subscription itself (back-in-stock:${sub.id}).
        // This guarantees the notification record's UNIQUE idempotency_key is identical
        // across consumer retries, crash recoveries, and duplicate inventory events.
        const notifResult = await this.notificationService.requestNotification({
          tenantId: sub.tenant_id,
          customerId: sub.customer_id,
          eventId: `back-in-stock:${sub.id}`,
          notificationType: 'BACK_IN_STOCK_ALERT',
          channel: 'EMAIL',
          recipient: sub.email,
          templateId: 'tpl_back_in_stock',
          payload: {
            subject,
            body,
            productId: sub.product_id,
            skuId: sub.sku_id,
            productTitle: sub.product_title,
            productImage: sub.product_thumbnail_url,
            productUrl: `${this.frontendUrl.replace(/\/$/, '')}/product/${sub.product_id}`,
          },
        });

        // Crash window recovery: If the notification was ALREADY sent in a prior run
        // (e.g. process crashed before markSubscriptionNotified completed),
        // do NOT dispatch to channel again!
        if (notifResult.status !== 'SENT') {
          const dispatchResult = await this.notificationService.processPendingNotifications();
          if (
            dispatchResult &&
            typeof dispatchResult.sent === 'number' &&
            dispatchResult.sent === 0 &&
            dispatchResult.failed > 0
          ) {
            throw new Error('Back-in-stock notification delivery failed during dispatch');
          }
        }
      }

      // 3. Mark subscription as NOTIFIED in transaction only AFTER delivery succeeds
      await this.db.withTransaction(async (tx) => {
        await this.repo.markSubscriptionNotified(tx, sub.id);

        // 4. Record outbox event BACK_IN_STOCK_NOTIFICATION_SENT
        if (this.outboxService) {
          const notifEvent = createDomainEvent({
            eventType: EventTypes.BACK_IN_STOCK_NOTIFICATION_SENT,
            eventVersion: 1,
            aggregateType: 'BackInStockSubscription',
            aggregateId: sub.id,
            tenantId: sub.tenant_id,
            payload: {
              subscriptionId: sub.id,
              customerId: sub.customer_id,
              productId: sub.product_id,
              skuId: sub.sku_id,
              recipient: sub.email,
              notifiedAt: new Date().toISOString(),
            },
            metadata: {
              source: 'back-in-stock-service',
            },
          });
          await this.outboxService.recordEvent(tx, notifEvent);
        }
      });

      notifiedCount += 1;
      this.logger.info('Back-in-stock alert dispatched successfully', {
        subscriptionId: sub.id,
        customerId: sub.customer_id,
        productId: sub.product_id,
        email: sub.email,
      });
    }

    return {
      processedCount: subscriptions.length,
      notifiedCount,
    };
  }
}
