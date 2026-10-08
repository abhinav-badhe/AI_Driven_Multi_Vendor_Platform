import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type {
  BackInStockSubscriptionRow,
  BackInStockSubscriptionWithDetailsRow,
} from './back-in-stock-models.js';

export interface ActiveSubscriptionForNotification {
  id: string;
  customer_id: string;
  tenant_id: string;
  product_id: string;
  sku_id: string | null;
  email: string;
  product_title: string;
  product_thumbnail_url: string | null;
}

export class BackInStockRepository {
  async validateProduct(
    db: DatabaseConnection,
    productId: string,
  ): Promise<{ id: string; status: string; title: string } | null> {
    const res = await db.query<{ id: string; status: string; title: string }>(
      'SELECT id, status, title FROM products WHERE id = $1',
      [productId],
    );
    return res.rows[0] ?? null;
  }

  async validateSkuBelongsToProduct(
    db: DatabaseConnection,
    productId: string,
    skuId: string,
  ): Promise<boolean> {
    const res = await db.query<{ id: string }>(
      'SELECT id FROM product_skus WHERE id = $1 AND product_id = $2',
      [skuId, productId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async checkAvailability(
    db: DatabaseConnection,
    productId: string,
    skuId?: string | null | undefined,
  ): Promise<{
    isAvailable: boolean;
    availableQuantity: number;
    status: 'IN_STOCK' | 'OUT_OF_STOCK' | 'UNAVAILABLE';
  }> {
    // 1. Verify Product
    const prodRes = await db.query<{ status: string }>(
      'SELECT status FROM products WHERE id = $1',
      [productId],
    );
    const prod = prodRes.rows[0];
    if (!prod || prod.status !== 'ACTIVE') {
      return {
        isAvailable: false,
        availableQuantity: 0,
        status: 'UNAVAILABLE',
      };
    }

    // 2. Resolve target SKU IDs
    let targetSkuIds: string[] = [];
    if (skuId) {
      targetSkuIds = [skuId];
    } else {
      const skusRes = await db.query<{ id: string }>(
        `SELECT id FROM product_skus WHERE product_id = $1 AND status = 'ACTIVE'`,
        [productId],
      );
      targetSkuIds = skusRes.rows.map((s) => s.id);
    }

    if (targetSkuIds.length === 0) {
      return {
        isAvailable: false,
        availableQuantity: 0,
        status: 'OUT_OF_STOCK',
      };
    }

    const inPlaceholders = targetSkuIds.map((_, i) => `$${i + 1}`).join(', ');
    const listingsRes = await db.query<{ available_quantity: number | string }>(
      `SELECT
         COALESCE(ii.on_hand_quantity - ii.reserved_quantity - ii.non_sellable_quantity, 0) AS available_quantity
       FROM merchant_listings ml
       LEFT JOIN inventory_items ii ON ii.listing_id = ml.id
       WHERE ml.sku_id IN (${inPlaceholders}) AND ml.status = 'ACTIVE'`,
      targetSkuIds,
    );

    let totalAvailable = 0;
    for (const row of listingsRes.rows) {
      const avail = Math.max(0, Number(row.available_quantity ?? 0));
      totalAvailable += avail;
    }

    if (totalAvailable > 0) {
      return {
        isAvailable: true,
        availableQuantity: totalAvailable,
        status: 'IN_STOCK',
      };
    }

    return {
      isAvailable: false,
      availableQuantity: 0,
      status: 'OUT_OF_STOCK',
    };
  }

  async upsertSubscription(
    db: DatabaseConnection,
    input: {
      id: string;
      customerId: string;
      tenantId: string;
      productId: string;
      skuId?: string | null | undefined;
    },
  ): Promise<BackInStockSubscriptionRow> {
    const res = await db.query<BackInStockSubscriptionRow>(
      `INSERT INTO back_in_stock_subscriptions (
         id, customer_id, tenant_id, product_id, sku_id, status, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (customer_id, product_id)
       DO UPDATE SET
         status = 'ACTIVE',
         sku_id = COALESCE(EXCLUDED.sku_id, back_in_stock_subscriptions.sku_id),
         notified_at = NULL,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *;`,
      [
        input.id,
        input.customerId,
        input.tenantId,
        input.productId,
        input.skuId ?? null,
      ],
    );
    return res.rows[0]!;
  }

  async cancelSubscription(
    db: DatabaseConnection,
    customerId: string,
    tenantId: string,
    productId: string,
  ): Promise<BackInStockSubscriptionRow | null> {
    const res = await db.query<BackInStockSubscriptionRow>(
      `UPDATE back_in_stock_subscriptions
       SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
       WHERE customer_id = $1 AND tenant_id = $2 AND product_id = $3 AND status = 'ACTIVE'
       RETURNING *;`,
      [customerId, tenantId, productId],
    );
    return res.rows[0] ?? null;
  }

  async findSubscription(
    db: DatabaseConnection,
    customerId: string,
    tenantId: string,
    productId: string,
  ): Promise<BackInStockSubscriptionRow | null> {
    const res = await db.query<BackInStockSubscriptionRow>(
      `SELECT * FROM back_in_stock_subscriptions
       WHERE customer_id = $1 AND tenant_id = $2 AND product_id = $3`,
      [customerId, tenantId, productId],
    );
    return res.rows[0] ?? null;
  }

  async listSubscriptions(
    db: DatabaseConnection,
    customerId: string,
    tenantId: string,
  ): Promise<BackInStockSubscriptionWithDetailsRow[]> {
    const res = await db.query<BackInStockSubscriptionWithDetailsRow>(
      `SELECT s.*,
              p.title as product_title, p.slug as product_slug, p.brand as product_brand,
              p.thumbnail_url as product_thumbnail_url, p.status as product_status,
              ps.sku_code, ps.attributes as sku_attributes
       FROM back_in_stock_subscriptions s
       JOIN products p ON p.id = s.product_id
       LEFT JOIN product_skus ps ON ps.id = s.sku_id
       WHERE s.customer_id = $1 AND s.tenant_id = $2
       ORDER BY s.created_at DESC`,
      [customerId, tenantId],
    );
    return res.rows;
  }

  async findActiveSubscriptionsForProduct(
    db: DatabaseConnection,
    productId: string,
    skuId?: string | null | undefined,
  ): Promise<ActiveSubscriptionForNotification[]> {
    let query: string;
    let params: unknown[];

    if (skuId) {
      query = `
        SELECT s.id, s.customer_id, s.tenant_id, s.product_id, s.sku_id,
               u.email, p.title as product_title, p.thumbnail_url as product_thumbnail_url
        FROM back_in_stock_subscriptions s
        JOIN users u ON u.id = s.customer_id
        JOIN products p ON p.id = s.product_id
        WHERE s.product_id = $1
          AND (s.sku_id IS NULL OR s.sku_id = $2)
          AND s.status = 'ACTIVE'
      `;
      params = [productId, skuId];
    } else {
      query = `
        SELECT s.id, s.customer_id, s.tenant_id, s.product_id, s.sku_id,
               u.email, p.title as product_title, p.thumbnail_url as product_thumbnail_url
        FROM back_in_stock_subscriptions s
        JOIN users u ON u.id = s.customer_id
        JOIN products p ON p.id = s.product_id
        WHERE s.product_id = $1
          AND s.status = 'ACTIVE'
      `;
      params = [productId];
    }

    const res = await db.query<ActiveSubscriptionForNotification>(query, params);
    return res.rows;
  }

  async markSubscriptionNotified(
    db: DatabaseConnection,
    subscriptionId: string,
  ): Promise<BackInStockSubscriptionRow | null> {
    const res = await db.query<BackInStockSubscriptionRow>(
      `UPDATE back_in_stock_subscriptions
       SET status = 'NOTIFIED', notified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *;`,
      [subscriptionId],
    );
    return res.rows[0] ?? null;
  }
}
