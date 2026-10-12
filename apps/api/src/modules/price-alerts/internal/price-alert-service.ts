import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { AuthorizedActor } from '../../identity/index.js';
import { ForbiddenError, NotFoundError } from '../../../errors/app-error.js';
import type { INotificationClient } from '../../notifications/index.js';
import { PriceAlertRepository } from './price-alert-repository.js';

export interface PriceWatchDto {
  productId: string;
  productTitle: string;
  lastSeenPrice: number | null;
  lastSeenCurrency: string | null;
  unsubscribed: boolean;
  updatedAt: string;
}

function formatMinor(minor: number, currency: string): string {
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

function parseBool(val: unknown): boolean {
  return val === true || val === 't' || val === 'true' || val === 1 || val === '1';
}

export class PriceAlertService {
  private readonly repo: PriceAlertRepository;

  constructor(
    private readonly db: DatabaseConnection,
    private readonly notifications: INotificationClient,
    private readonly logger: Logger,
    private readonly frontendUrl: string,
  ) {
    this.repo = new PriceAlertRepository(db);
  }

  /** Records that a customer viewed a product (the interest signal for alerts). */
  async recordView(
    actor: AuthorizedActor,
    productId: string,
    priceSeenMinor?: number | null,
    currency?: string | null,
  ): Promise<{ tracked: boolean }> {
    if (actor.role !== 'CUSTOMER') {
      throw new ForbiddenError('Only customers can track product views');
    }
    if (!(await this.repo.productExists(productId))) {
      throw new NotFoundError(`Product '${productId}' not found`);
    }
    const price =
      typeof priceSeenMinor === 'number' && Number.isFinite(priceSeenMinor) && priceSeenMinor >= 0
        ? Math.round(priceSeenMinor)
        : null;
    const cur =
      typeof currency === 'string' && currency.length === 3 ? currency.toUpperCase() : null;
    await this.repo.recordView(actor.tenantId, productId, price, cur);
    return { tracked: true };
  }

  async listMyWatches(actor: AuthorizedActor): Promise<PriceWatchDto[]> {
    if (actor.role !== 'CUSTOMER') {
      throw new ForbiddenError('Only customers have price watches');
    }
    const rows = await this.repo.listWatchesForCustomer(actor.tenantId);
    const result: PriceWatchDto[] = [];
    for (const row of rows) {
      const basics = await this.repo.productBasics(row.product_id);
      result.push({
        productId: row.product_id,
        productTitle: basics?.title ?? row.product_id,
        lastSeenPrice: row.last_seen_price != null ? Number(row.last_seen_price) : null,
        lastSeenCurrency: row.last_seen_currency,
        unsubscribed: parseBool(row.unsubscribed),
        updatedAt: new Date(row.updated_at).toISOString(),
      });
    }
    return result;
  }

  async unsubscribe(actor: AuthorizedActor, productId: string): Promise<{ unsubscribed: boolean }> {
    if (actor.role !== 'CUSTOMER') {
      throw new ForbiddenError('Only customers have price watches');
    }
    await this.repo.setUnsubscribed(actor.tenantId, productId, true);
    return { unsubscribed: true };
  }

  /**
   * Reconciles all delivered (SENT) notifications with product_price_watches.
   * Completely independent of current floor prices or live catalog availability.
   * Idempotent: will not double-increment alert_count or regress last_alerted_price.
   */
  async reconcileDeliveredAlerts(sinceDays = 90): Promise<{ reconciled: number }> {
    const delivered = await this.repo.findDeliveredAlerts(sinceDays);
    let reconciled = 0;
    for (const item of delivered) {
      try {
        const updated = await this.repo.markAlerted(
          item.customer_tenant_id,
          item.product_id,
          item.price_minor,
        );
        if (updated) {
          reconciled += 1;
        }
      } catch (err: unknown) {
        this.logger.warn('Failed to reconcile delivered price alert', {
          customerTenantId: item.customer_tenant_id,
          productId: item.product_id,
          priceMinor: item.price_minor,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { reconciled };
  }

  async reconcileDeliveredAlertsForProduct(productId: string): Promise<number> {
    const delivered = await this.repo.findDeliveredAlertsForProduct(productId);
    let count = 0;
    for (const item of delivered) {
      try {
        const updated = await this.repo.markAlerted(
          item.customer_tenant_id,
          item.product_id,
          item.price_minor,
        );
        if (updated) {
          count += 1;
        }
      } catch (err: unknown) {
        this.logger.warn('Failed to reconcile delivered price alert for product', {
          productId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return count;
  }

  /**
   * Checks one product for a genuine drop and emails eligible watchers.
   * Called after listing price changes and by the admin sweep.
   */
  async checkProduct(productId: string): Promise<{ checked: boolean; alertsSent: number }> {
    const floor = await this.repo.currentFloorPrice(productId);
    if (!floor) return { checked: false, alertsSent: 0 };

    const candidates = await this.repo.findAlertCandidates(productId, floor.price);
    if (candidates.length === 0) return { checked: true, alertsSent: 0 };

    const basics = await this.repo.productBasics(productId);
    const forecast = await this.repo.demandForecast(productId);
    let alertsSent = 0;

    for (const watch of candidates) {
      const dropPct = Math.round((1 - floor.price / watch.last_seen_price) * 100);
      const lines = [
        `Good news — a product you viewed just dropped in price.`,
        ``,
        `${basics?.title ?? 'A product'}${basics?.brand ? ` by ${basics.brand}` : ''}`,
        `Was ${formatMinor(watch.last_seen_price, watch.last_seen_currency || floor.currency)} — now ${formatMinor(floor.price, floor.currency)} (${dropPct}% off).`,
        forecast
          ? `Our demand model expects about ${Math.round(forecast.value)} units wanted over the next ${forecast.horizon} — it may not stay at this price.`
          : null,
        ``,
        `View it here: ${this.frontendUrl.replace(/\/$/, '')}/product/${productId}`,
        ``,
        `You received this because you viewed this product. Manage alerts in your account notification settings.`,
      ].filter((l): l is string => l !== null);

      try {
        const notifResult = await this.notifications.requestNotification({
          tenantId: watch.customer_tenant_id,
          customerId: watch.user_id,
          eventId: `price-drop:${productId}:${floor.price}`,
          notificationType: 'PRICE_DROP_ALERT',
          channel: 'EMAIL',
          recipient: watch.email,
          templateId: 'tpl_price_drop',
          payload: {
            subject: `Price drop: ${basics?.title ?? 'a product you viewed'} is now ${formatMinor(floor.price, floor.currency)}`,
            body: lines.join('\n'),
            productId,
            oldPrice: watch.last_seen_price,
            newPrice: floor.price,
            currency: floor.currency,
          },
        });

        if (notifResult.skipped) {
          this.logger.info('Price-drop alert skipped by customer notification preferences', {
            productId,
            email: watch.email,
            reason: notifResult.reason,
          });
        } else if (notifResult.status === 'SENT') {
          // Delivered to recipient: safely record that watcher was alerted at this price floor.
          await this.repo.markAlerted(watch.customer_tenant_id, productId, floor.price);
          alertsSent += 1;
        } else if (notifResult.status === 'PENDING') {
          // Accepted and queued for asynchronous delivery by the notification processor.
          // Crucial: Do NOT mark alerted in repository until delivery is confirmed (SENT).
          // Idempotency on (eventId:type:recipient:channel) prevents duplicate queued records.
          alertsSent += 1;
        } else if (notifResult.status === 'DEAD_LETTERED') {
          this.logger.warn('Price-drop notification is dead-lettered; not marking alerted', {
            productId,
            email: watch.email,
            notificationId: notifResult.notificationId,
          });
        }
      } catch (err: unknown) {
        this.logger.warn('Price-drop alert failed for watcher', {
          productId,
          email: watch.email,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { checked: true, alertsSent };
  }

  /**
   * Entry point after a listing price change: resolves the product and runs
   * the drop check. Never throws — alerts must not break listing updates.
   */
  async checkListing(listingId: string): Promise<{ checked: boolean; alertsSent: number }> {
    try {
      const res = await this.db.query<{ product_id: string }>(
        `SELECT s.product_id FROM merchant_listings l
         JOIN product_skus s ON s.id = l.sku_id
         WHERE l.id = $1`,
        [listingId],
      );
      const productId = res.rows[0]?.product_id;
      if (!productId) return { checked: false, alertsSent: 0 };
      return await this.checkProduct(productId);
    } catch (err: unknown) {
      this.logger.warn('Price-drop check failed for listing', {
        listingId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { checked: false, alertsSent: 0 };
    }
  }

  /** Admin sweep across recently watched products. */
  async sweepAll(
    sinceDays = 90,
  ): Promise<{ productsChecked: number; alertsSent: number; reconciled: number }> {
    // 1. Reconcile all delivered notifications across all products, regardless of current floor price or stock
    const { reconciled } = await this.reconcileDeliveredAlerts(sinceDays);

    // 2. Sweep watched products for newly eligible price drops
    const productIds = await this.repo.distinctWatchedProductIds(sinceDays);
    let alertsSent = 0;
    for (const productId of productIds) {
      try {
        const result = await this.checkProduct(productId);
        alertsSent += result.alertsSent;
      } catch (err: unknown) {
        this.logger.warn('Price-drop sweep failed for product', {
          productId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { productsChecked: productIds.length, alertsSent, reconciled };
  }
}
