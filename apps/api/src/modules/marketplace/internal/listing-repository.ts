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
  limit?: number | undefined;
  offset?: number | undefined;
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
}
