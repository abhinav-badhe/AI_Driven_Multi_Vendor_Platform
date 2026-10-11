import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';

export type ListingStatus = 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';

export interface MerchantListingRow {
  id: string;
  tenant_id: string;
  sku_id: string;
  price_amount: number;
  currency: string;
  compare_at_price: number | null;
  status: ListingStatus;
  created_at: string;
  updated_at: string;
}

export interface ListListingsFilter {
  status?: ListingStatus | undefined;
  skuId?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface MerchantListingDetailRow extends MerchantListingRow {
  sku_code: string;
  product_id: string;
  product_title: string;
  product_slug: string;
  product_brand: string | null;
  thumbnail_url: string | null;
  images: unknown;
  rating: string | number | null;
  review_count: string | number | null;
  on_hand_quantity: number | string | null;
  reserved_quantity: number | string | null;
  non_sellable_quantity: number | string | null;
  inventory_version: number | string | null;
}

export class ListingRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async createListing(data: {
    id?: string | undefined;
    tenantId: string;
    skuId: string;
    priceAmount: number;
    currency: string;
    compareAtPrice?: number | null | undefined;
    status?: ListingStatus | undefined;
  }): Promise<MerchantListingRow> {
    const id = data.id ?? randomUUID();
    const status = data.status ?? 'DRAFT';
    const res = await this.db.query<MerchantListingRow>(
      `INSERT INTO merchant_listings (id, tenant_id, sku_id, price_amount, currency, compare_at_price, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, tenant_id, sku_id, price_amount, currency, compare_at_price, status, created_at, updated_at`,
      [
        id,
        data.tenantId,
        data.skuId,
        data.priceAmount,
        data.currency,
        data.compareAtPrice ?? null,
        status,
      ],
    );
    return res.rows[0]!;
  }

  async findListingById(id: string): Promise<MerchantListingRow | null> {
    const res = await this.db.query<MerchantListingRow>(
      `SELECT id, tenant_id, sku_id, price_amount, currency, compare_at_price, status, created_at, updated_at
       FROM merchant_listings
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findListingByMerchantAndSku(
    tenantId: string,
    skuId: string,
  ): Promise<MerchantListingRow | null> {
    const res = await this.db.query<MerchantListingRow>(
      `SELECT id, tenant_id, sku_id, price_amount, currency, compare_at_price, status, created_at, updated_at
       FROM merchant_listings
       WHERE tenant_id = $1 AND sku_id = $2`,
      [tenantId, skuId],
    );
    return res.rows[0] ?? null;
  }

  async listListingsByTenant(
    tenantId: string,
    filter?: ListListingsFilter,
  ): Promise<MerchantListingRow[]> {
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    let paramIndex = 2;

    if (filter?.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filter.status);
    }

    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;

    params.push(limit);
    const limitParam = `$${paramIndex++}`;
    params.push(offset);
    const offsetParam = `$${paramIndex++}`;

    const res = await this.db.query<MerchantListingRow>(
      `SELECT id, tenant_id, sku_id, price_amount, currency, compare_at_price, status, created_at, updated_at
       FROM merchant_listings
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    );
    return res.rows;
  }

  async listActiveListingsBySku(skuId: string): Promise<MerchantListingRow[]> {
    const res = await this.db.query<MerchantListingRow>(
      `SELECT id, tenant_id, sku_id, price_amount, currency, compare_at_price, status, created_at, updated_at
       FROM merchant_listings
       WHERE sku_id = $1 AND status = 'ACTIVE'
       ORDER BY price_amount ASC`,
      [skuId],
    );
    return res.rows;
  }

  /**
   * Merchant console view: listings joined with SKU, product display content
   * and inventory levels so sellers manage products — never raw IDs.
   */
  async listListingDetailsByTenant(tenantId: string): Promise<MerchantListingDetailRow[]> {
    const res = await this.db.query<MerchantListingDetailRow>(
      `SELECT l.id, l.tenant_id, l.sku_id, l.price_amount, l.currency, l.compare_at_price,
              l.status, l.created_at, l.updated_at,
              s.sku_code,
              p.id AS product_id, p.title AS product_title, p.slug AS product_slug,
              p.brand AS product_brand, p.thumbnail_url, p.images, p.rating, p.review_count,
              i.on_hand_quantity, i.reserved_quantity, i.non_sellable_quantity,
              i.version AS inventory_version
       FROM merchant_listings l
       JOIN product_skus s ON s.id = l.sku_id
       JOIN products p ON p.id = s.product_id
       LEFT JOIN inventory_items i ON i.listing_id = l.id
       WHERE l.tenant_id = $1
       ORDER BY l.updated_at DESC`,
      [tenantId],
    );
    return res.rows;
  }

  async updateListing(
    id: string,
    updates: {
      priceAmount?: number | undefined;
      currency?: string | undefined;
      compareAtPrice?: number | null | undefined;
      status?: ListingStatus | undefined;
    },
  ): Promise<MerchantListingRow | null> {
    const current = await this.findListingById(id);
    if (!current) return null;

    const priceAmount = updates.priceAmount !== undefined ? updates.priceAmount : current.price_amount;
    const currency = updates.currency !== undefined ? updates.currency : current.currency;
    const compareAtPrice =
      updates.compareAtPrice !== undefined ? updates.compareAtPrice : current.compare_at_price;
    const status = updates.status !== undefined ? updates.status : current.status;

    const res = await this.db.query<MerchantListingRow>(
      `UPDATE merchant_listings
       SET price_amount = $1, currency = $2, compare_at_price = $3, status = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING id, tenant_id, sku_id, price_amount, currency, compare_at_price, status, created_at, updated_at`,
      [priceAmount, currency, compareAtPrice, status, id],
    );
    return res.rows[0] ?? null;
  }

  async listAllListings(filter?: ListListingsFilter): Promise<MerchantListingRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filter?.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filter.status);
    }

    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;

    params.push(limit);
    const limitParam = `$${paramIndex++}`;
    params.push(offset);
    const offsetParam = `$${paramIndex++}`;

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await this.db.query<MerchantListingRow>(
      `SELECT id, tenant_id, sku_id, price_amount, currency, compare_at_price, status, created_at, updated_at
       FROM merchant_listings
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    );
    return res.rows;
  }
}

