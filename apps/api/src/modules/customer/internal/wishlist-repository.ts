import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type {
  WishlistItemRow,
  WishlistItemDto,
  WishlistProductSummary,
  WishlistSkuSummary,
  WishlistOfferSummary,
  WishlistAvailabilitySummary,
} from './wishlist-models.js';

export class WishlistRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async addItem(
    customerId: string,
    tenantId: string,
    productId: string,
    skuId?: string | null,
  ): Promise<WishlistItemRow> {
    const id = randomUUID();
    const result = await this.db.query<WishlistItemRow>(
      `INSERT INTO wishlist_items (id, customer_id, tenant_id, product_id, sku_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (customer_id, product_id)
       DO UPDATE SET
         sku_id = COALESCE(EXCLUDED.sku_id, wishlist_items.sku_id),
         updated_at = CURRENT_TIMESTAMP
       RETURNING id, customer_id, tenant_id, product_id, sku_id, created_at, updated_at`,
      [id, customerId, tenantId, productId, skuId ?? null],
    );

    return result.rows[0]!;
  }

  async findItemByCustomerAndProduct(
    customerId: string,
    productId: string,
  ): Promise<WishlistItemRow | null> {
    const result = await this.db.query<WishlistItemRow>(
      `SELECT id, customer_id, tenant_id, product_id, sku_id, created_at, updated_at
       FROM wishlist_items
       WHERE customer_id = $1 AND product_id = $2`,
      [customerId, productId],
    );
    return result.rows[0] ?? null;
  }

  async findItemById(
    customerId: string,
    id: string,
  ): Promise<WishlistItemRow | null> {
    const result = await this.db.query<WishlistItemRow>(
      `SELECT id, customer_id, tenant_id, product_id, sku_id, created_at, updated_at
       FROM wishlist_items
       WHERE customer_id = $1 AND id = $2`,
      [customerId, id],
    );
    return result.rows[0] ?? null;
  }

  async removeItemByProduct(
    customerId: string,
    productId: string,
  ): Promise<WishlistItemRow | null> {
    const result = await this.db.query<WishlistItemRow>(
      `DELETE FROM wishlist_items
       WHERE customer_id = $1 AND product_id = $2
       RETURNING id, customer_id, tenant_id, product_id, sku_id, created_at, updated_at`,
      [customerId, productId],
    );
    return result.rows[0] ?? null;
  }

  async removeItemById(
    customerId: string,
    id: string,
  ): Promise<WishlistItemRow | null> {
    const result = await this.db.query<WishlistItemRow>(
      `DELETE FROM wishlist_items
       WHERE customer_id = $1 AND id = $2
       RETURNING id, customer_id, tenant_id, product_id, sku_id, created_at, updated_at`,
      [customerId, id],
    );
    return result.rows[0] ?? null;
  }

  async listItemsByCustomer(
    customerId: string,
    tenantId: string,
  ): Promise<WishlistItemRow[]> {
    const result = await this.db.query<WishlistItemRow>(
      `SELECT id, customer_id, tenant_id, product_id, sku_id, created_at, updated_at
       FROM wishlist_items
       WHERE customer_id = $1 AND tenant_id = $2
       ORDER BY created_at DESC`,
      [customerId, tenantId],
    );
    return result.rows;
  }

  async resolveWishlistItemDetails(item: WishlistItemRow): Promise<WishlistItemDto> {
    // 1. Resolve canonical product details
    const productResult = await this.db.query<{
      id: string;
      title: string;
      slug: string;
      brand: string | null;
      thumbnail_url: string | null;
      images: string[] | null;
      status: string;
      rating: number | null;
      review_count: number | null;
    }>(
      `SELECT id, title, slug, brand, thumbnail_url, images, status, rating, review_count
       FROM products
       WHERE id = $1`,
      [item.product_id],
    );

    const rawProduct = productResult.rows[0];
    const productSummary: WishlistProductSummary = rawProduct
      ? {
          id: rawProduct.id,
          title: rawProduct.title,
          slug: rawProduct.slug,
          brand: rawProduct.brand,
          thumbnailUrl: rawProduct.thumbnail_url,
          images: Array.isArray(rawProduct.images) ? rawProduct.images : [],
          status: rawProduct.status,
          rating: rawProduct.rating != null ? Number(rawProduct.rating) : null,
          reviewCount: rawProduct.review_count != null ? Number(rawProduct.review_count) : 0,
        }
      : {
          id: item.product_id,
          title: 'Unknown Product',
          slug: 'unknown-product',
          brand: null,
          thumbnailUrl: null,
          images: [],
          status: 'UNAVAILABLE',
          rating: null,
          reviewCount: 0,
        };

    // 2. Resolve SKU details
    let skuSummary: WishlistSkuSummary | null = null;
    let targetSkuIds: string[] = [];

    if (item.sku_id) {
      const skuResult = await this.db.query<{
        id: string;
        sku_code: string;
        attributes: Record<string, unknown> | null;
      }>(
        `SELECT id, sku_code, attributes FROM product_skus WHERE id = $1`,
        [item.sku_id],
      );
      if (skuResult.rows[0]) {
        skuSummary = {
          id: skuResult.rows[0].id,
          skuCode: skuResult.rows[0].sku_code,
          attributes: skuResult.rows[0].attributes ?? {},
        };
        targetSkuIds = [skuResult.rows[0].id];
      }
    }

    if (targetSkuIds.length === 0) {
      // Find all active SKUs for the product
      const allSkusResult = await this.db.query<{
        id: string;
        sku_code: string;
        attributes: Record<string, unknown> | null;
      }>(
        `SELECT id, sku_code, attributes FROM product_skus WHERE product_id = $1 AND status = 'ACTIVE'`,
        [item.product_id],
      );
      targetSkuIds = allSkusResult.rows.map((s) => s.id);
      if (!skuSummary && allSkusResult.rows[0]) {
        skuSummary = {
          id: allSkusResult.rows[0].id,
          skuCode: allSkusResult.rows[0].sku_code,
          attributes: allSkusResult.rows[0].attributes ?? {},
        };
      }
    }

    // 3. Resolve active marketplace listings and inventory availability
    let offerSummary: WishlistOfferSummary | null = null;
    let availabilitySummary: WishlistAvailabilitySummary = {
      isAvailable: false,
      availableQuantity: 0,
      status: 'UNAVAILABLE',
    };

    if (productSummary.status === 'ACTIVE' && targetSkuIds.length > 0) {
      const inPlaceholders = targetSkuIds.map((_, i) => `$${i + 1}`).join(', ');
      const listingsResult = await this.db.query<{
        listing_id: string;
        merchant_tenant_id: string;
        sku_id: string;
        price_amount: number;
        currency: string;
        compare_at_price: number | null;
        available_quantity: number | null;
      }>(
        `SELECT
           ml.id AS listing_id,
           ml.tenant_id AS merchant_tenant_id,
           ml.sku_id,
           ml.price_amount,
           ml.currency,
           ml.compare_at_price,
           COALESCE(ii.on_hand_quantity - ii.reserved_quantity - ii.non_sellable_quantity, 0) AS available_quantity
         FROM merchant_listings ml
         LEFT JOIN inventory_items ii ON ii.listing_id = ml.id
         WHERE ml.sku_id IN (${inPlaceholders}) AND ml.status = 'ACTIVE'
         ORDER BY ml.price_amount ASC
         LIMIT 1`,
        targetSkuIds,
      );

      const bestListing = listingsResult.rows[0];
      if (bestListing) {
        offerSummary = {
          listingId: bestListing.listing_id,
          merchantTenantId: bestListing.merchant_tenant_id,
          priceAmount: Number(bestListing.price_amount),
          currency: bestListing.currency,
          compareAtPrice: bestListing.compare_at_price != null ? Number(bestListing.compare_at_price) : null,
        };

        const availQty = Math.max(0, Number(bestListing.available_quantity ?? 0));
        availabilitySummary = {
          isAvailable: availQty > 0,
          availableQuantity: availQty,
          status: availQty > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK',
        };
      } else {
        availabilitySummary = {
          isAvailable: false,
          availableQuantity: 0,
          status: 'UNAVAILABLE',
        };
      }
    }

    return {
      id: item.id,
      customerId: item.customer_id,
      tenantId: item.tenant_id,
      productId: item.product_id,
      skuId: item.sku_id,
      product: productSummary,
      sku: skuSummary,
      offer: offerSummary,
      availability: availabilitySummary,
      createdAt: item.created_at.toISOString(),
      updatedAt: item.updated_at.toISOString(),
    };
  }
}
