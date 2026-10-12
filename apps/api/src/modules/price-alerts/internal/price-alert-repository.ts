import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';

export interface PriceWatchRow {
  id: string;
  customer_tenant_id: string;
  product_id: string;
  last_seen_price: number | string | null;
  last_seen_currency: string | null;
  last_alerted_price: number | string | null;
  alert_count: number | string;
  unsubscribed: boolean | string;
  created_at: string;
  updated_at: string;
}

export interface WatchCandidateRow {
  customer_tenant_id: string;
  product_id: string;
  last_seen_price: number;
  last_seen_currency: string;
  last_alerted_price: number | null;
  user_id: string;
  email: string;
}

export class PriceAlertRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async recordView(
    customerTenantId: string,
    productId: string,
    priceMinor: number | null,
    currency: string | null,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO product_price_watches
         (id, customer_tenant_id, product_id, last_seen_price, last_seen_currency)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (customer_tenant_id, product_id)
       DO UPDATE SET
         last_seen_price = EXCLUDED.last_seen_price,
         last_seen_currency = EXCLUDED.last_seen_currency,
         updated_at = CURRENT_TIMESTAMP`,
      [randomUUID(), customerTenantId, productId, priceMinor, currency],
    );
  }

  async setUnsubscribed(
    customerTenantId: string,
    productId: string,
    value: boolean,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO product_price_watches (id, customer_tenant_id, product_id, unsubscribed)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (customer_tenant_id, product_id)
       DO UPDATE SET unsubscribed = EXCLUDED.unsubscribed, updated_at = CURRENT_TIMESTAMP`,
      [randomUUID(), customerTenantId, productId, value],
    );
  }

  async listWatchesForCustomer(customerTenantId: string): Promise<PriceWatchRow[]> {
    const res = await this.db.query<PriceWatchRow>(
      `SELECT * FROM product_price_watches WHERE customer_tenant_id = $1 ORDER BY updated_at DESC`,
      [customerTenantId],
    );
    return res.rows;
  }

  async distinctWatchedProductIds(sinceDays = 90): Promise<string[]> {
    // Cutoff computed in JS: pg-mem cannot cast concatenated interval expressions.
    const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
    const res = await this.db.query<{ product_id: string }>(
      `SELECT DISTINCT product_id FROM product_price_watches
       WHERE unsubscribed = FALSE AND updated_at > $1`,
      [cutoff],
    );
    return res.rows.map((r) => r.product_id);
  }

  /**
   * Watchers eligible for an alert at the given current price: verified users
   * whose last seen price beats it by a margin and who were not already
   * alerted at an equal-or-lower price.
   */
  async findAlertCandidates(
    productId: string,
    currentMinMinor: number,
  ): Promise<WatchCandidateRow[]> {
    const eventId = `price-drop:${productId}:${currentMinMinor}`;
    const res = await this.db.query<WatchCandidateRow>(
      `SELECT w.customer_tenant_id, w.product_id,
              w.last_seen_price, w.last_seen_currency, w.last_alerted_price,
              u.id AS user_id, u.email AS email
       FROM product_price_watches w
       JOIN tenant_memberships tm
         ON tm.tenant_id = w.customer_tenant_id AND tm.status = 'ACTIVE'
       JOIN users u
         ON u.id = tm.user_id AND u.status = 'ACTIVE' AND u.email_verified_at IS NOT NULL
       LEFT JOIN notifications n
         ON n.tenant_id = w.customer_tenant_id AND n.event_id = $3
       WHERE w.product_id = $1
         AND w.unsubscribed = FALSE
         AND w.last_seen_price IS NOT NULL
         AND w.last_seen_price > $2 * 1.01
         AND (w.last_alerted_price IS NULL OR w.last_alerted_price > $2)
         AND n.id IS NULL`,
      [productId, currentMinMinor, eventId],
    );
    return res.rows.map((r) => ({
      ...r,
      last_seen_price: Number(r.last_seen_price),
      last_alerted_price: r.last_alerted_price != null ? Number(r.last_alerted_price) : null,
    }));
  }

  /**
   * Idempotently marks a watch as alerted at a specific price floor.
   * Guards against duplicate increments: only updates if last_alerted_price
   * is null or higher than the alerted price.
   */
  async markAlerted(
    customerTenantId: string,
    productId: string,
    priceMinor: number,
  ): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE product_price_watches
       SET last_alerted_price = $3,
           alert_count = alert_count + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE customer_tenant_id = $1
         AND product_id = $2
         AND (last_alerted_price IS NULL OR last_alerted_price > $3)`,
      [customerTenantId, productId, priceMinor],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Finds all delivered (SENT) price drop notifications across all products within the horizon.
   * Completely independent of current floor prices or live catalog availability.
   */
  async findDeliveredAlerts(sinceDays = 90): Promise<
    Array<{
      notification_id: string;
      customer_tenant_id: string;
      product_id: string;
      price_minor: number;
    }>
  > {
    const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
    const res = await this.db.query<{
      notification_id: string;
      customer_tenant_id: string;
      event_id: string;
      payload: unknown;
    }>(
      `SELECT n.id AS notification_id,
              n.tenant_id AS customer_tenant_id,
              n.event_id,
              n.payload
       FROM notifications n
       WHERE n.notification_type = 'PRICE_DROP_ALERT'
         AND n.status = 'SENT'
         AND n.updated_at > $1
       ORDER BY n.updated_at ASC`,
      [cutoff],
    );

    const results: Array<{
      notification_id: string;
      customer_tenant_id: string;
      product_id: string;
      price_minor: number;
    }> = [];

    for (const row of res.rows) {
      let productId: string | undefined;
      let priceMinor: number | undefined;

      if (row.payload && typeof row.payload === 'object') {
        const p = row.payload as Record<string, unknown>;
        if (typeof p.productId === 'string') productId = p.productId;
        if (typeof p.newPrice === 'number') priceMinor = p.newPrice;
      } else if (typeof row.payload === 'string') {
        try {
          const p = JSON.parse(row.payload) as Record<string, unknown>;
          if (typeof p.productId === 'string') productId = p.productId;
          if (typeof p.newPrice === 'number') priceMinor = p.newPrice;
        } catch {
          // Fall back to event_id
        }
      }

      if (!productId || priceMinor === undefined) {
        if (row.event_id && typeof row.event_id === 'string') {
          const parts = row.event_id.split(':');
          if (parts.length >= 3 && parts[0] === 'price-drop') {
            productId = productId ?? parts[1];
            const parsed = Number(parts[2]);
            if (!isNaN(parsed)) priceMinor = priceMinor ?? parsed;
          }
        }
      }

      if (productId && priceMinor !== undefined) {
        results.push({
          notification_id: row.notification_id,
          customer_tenant_id: row.customer_tenant_id,
          product_id: productId,
          price_minor: priceMinor,
        });
      }
    }

    return results;
  }

  /**
   * Finds all delivered (SENT) price drop notifications for a specific product.
   */
  async findDeliveredAlertsForProduct(productId: string): Promise<
    Array<{
      notification_id: string;
      customer_tenant_id: string;
      product_id: string;
      price_minor: number;
    }>
  > {
    const res = await this.db.query<{
      notification_id: string;
      customer_tenant_id: string;
      event_id: string;
      payload: unknown;
    }>(
      `SELECT n.id AS notification_id,
              n.tenant_id AS customer_tenant_id,
              n.event_id,
              n.payload
       FROM notifications n
       WHERE n.notification_type = 'PRICE_DROP_ALERT'
         AND n.status = 'SENT'
         AND n.event_id LIKE $1
       ORDER BY n.updated_at ASC`,
      [`price-drop:${productId}:%`],
    );

    const results: Array<{
      notification_id: string;
      customer_tenant_id: string;
      product_id: string;
      price_minor: number;
    }> = [];

    for (const row of res.rows) {
      let prodId: string | undefined = productId;
      let priceMinor: number | undefined;

      if (row.payload && typeof row.payload === 'object') {
        const p = row.payload as Record<string, unknown>;
        if (typeof p.productId === 'string') prodId = p.productId;
        if (typeof p.newPrice === 'number') priceMinor = p.newPrice;
      } else if (typeof row.payload === 'string') {
        try {
          const p = JSON.parse(row.payload) as Record<string, unknown>;
          if (typeof p.productId === 'string') prodId = p.productId;
          if (typeof p.newPrice === 'number') priceMinor = p.newPrice;
        } catch {
          // Fall back to event_id
        }
      }

      if (priceMinor === undefined) {
        if (row.event_id && typeof row.event_id === 'string') {
          const parts = row.event_id.split(':');
          if (parts.length >= 3 && parts[0] === 'price-drop') {
            const parsed = Number(parts[2]);
            if (!isNaN(parsed)) priceMinor = parsed;
          }
        }
      }

      if (prodId && priceMinor !== undefined) {
        results.push({
          notification_id: row.notification_id,
          customer_tenant_id: row.customer_tenant_id,
          product_id: prodId,
          price_minor: priceMinor,
        });
      }
    }

    return results;
  }

  async productExists(productId: string): Promise<boolean> {
    const res = await this.db.query<{ id: string }>(`SELECT id FROM products WHERE id = $1`, [
      productId,
    ]);
    return res.rows.length > 0;
  }

  async productBasics(productId: string): Promise<{
    title: string;
    brand: string | null;
    thumbnail: string | null;
  } | null> {
    const res = await this.db.query<{
      title: string;
      brand: string | null;
      thumbnail_url: string | null;
    }>(`SELECT title, brand, thumbnail_url FROM products WHERE id = $1`, [productId]);
    const row = res.rows[0];
    if (!row) return null;
    return { title: row.title, brand: row.brand, thumbnail: row.thumbnail_url };
  }

  /**
   * Current floor price across ACTIVE listings with available stock;
   * falls back to any ACTIVE listing when nothing is in stock.
   */
  async currentFloorPrice(productId: string): Promise<{ price: number; currency: string } | null> {
    const stocked = await this.db.query<{ price_amount: number | string; currency: string }>(
      `SELECT l.price_amount, l.currency
       FROM merchant_listings l
       JOIN product_skus s ON s.id = l.sku_id
       JOIN inventory_items i ON i.listing_id = l.id
       WHERE s.product_id = $1
         AND l.status = 'ACTIVE'
         AND (i.on_hand_quantity - i.reserved_quantity - i.non_sellable_quantity) > 0
       ORDER BY l.price_amount ASC
       LIMIT 1`,
      [productId],
    );
    if (stocked.rows[0]) {
      return { price: Number(stocked.rows[0].price_amount), currency: stocked.rows[0].currency };
    }
    const anyActive = await this.db.query<{ price_amount: number | string; currency: string }>(
      `SELECT l.price_amount, l.currency
       FROM merchant_listings l
       JOIN product_skus s ON s.id = l.sku_id
       WHERE s.product_id = $1 AND l.status = 'ACTIVE'
       ORDER BY l.price_amount ASC
       LIMIT 1`,
      [productId],
    );
    if (anyActive.rows[0]) {
      return {
        price: Number(anyActive.rows[0].price_amount),
        currency: anyActive.rows[0].currency,
      };
    }
    return null;
  }

  /** Latest demand forecast for a product, if any model produced one. */
  async demandForecast(productId: string): Promise<{ value: number; horizon: string } | null> {
    try {
      const res = await this.db.query<{ prediction_value: number | string; horizon: string }>(
        `SELECT prediction_value, horizon FROM ml_predictions
         WHERE model_type = 'DEMAND_FORECASTING' AND entity_type = 'PRODUCT' AND entity_id = $1
         ORDER BY predicted_at DESC LIMIT 1`,
        [productId],
      );
      const row = res.rows[0];
      if (!row) return null;
      return { value: Number(row.prediction_value), horizon: row.horizon };
    } catch {
      return null;
    }
  }
}
