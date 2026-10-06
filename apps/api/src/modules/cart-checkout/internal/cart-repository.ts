import type { DatabaseConnection } from '../../../infra/database/connection.js';
import { randomUUID } from 'node:crypto';

export interface CartRow {
  id: string;
  tenant_id: string;
  status: 'ACTIVE' | 'ABANDONED' | 'CONVERTED';
  created_at: Date;
  updated_at: Date;
}

export interface CartItemRow {
  id: string;
  cart_id: string;
  listing_id: string;
  sku_id: string;
  merchant_tenant_id: string;
  quantity: number;
  created_at: Date;
  updated_at: Date;
  product_id?: string | null | undefined;
  product_title?: string | null | undefined;
  product_brand?: string | null | undefined;
  product_thumbnail_url?: string | null | undefined;
}

export class CartRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async findOrCreateCart(tenantId: string): Promise<CartRow> {
    const existing = await this.findCartByTenantId(tenantId);
    if (existing) return existing;

    const id = randomUUID();
    const res = await this.db.query<CartRow>(
      `INSERT INTO carts (id, tenant_id, status)
       VALUES ($1, $2, 'ACTIVE')
       ON CONFLICT (tenant_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
       RETURNING id, tenant_id, status, created_at, updated_at`,
      [id, tenantId],
    );
    return res.rows[0]!;
  }

  async findCartByTenantId(tenantId: string): Promise<CartRow | null> {
    const res = await this.db.query<CartRow>(
      `SELECT id, tenant_id, status, created_at, updated_at
       FROM carts
       WHERE tenant_id = $1 AND status = 'ACTIVE'`,
      [tenantId],
    );
    return res.rows[0] ?? null;
  }

  async findCartById(id: string): Promise<CartRow | null> {
    const res = await this.db.query<CartRow>(
      `SELECT id, tenant_id, status, created_at, updated_at
       FROM carts
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async getCartItems(cartId: string): Promise<CartItemRow[]> {
    const res = await this.db.query<CartItemRow>(
      `SELECT ci.id, ci.cart_id, ci.listing_id, ci.sku_id, ci.merchant_tenant_id,
              ci.quantity, ci.created_at, ci.updated_at,
              p.id AS product_id, p.title AS product_title,
              p.brand AS product_brand, p.thumbnail_url AS product_thumbnail_url
       FROM cart_items ci
       LEFT JOIN product_skus s ON s.id = ci.sku_id
       LEFT JOIN products p ON p.id = s.product_id
       WHERE ci.cart_id = $1
       ORDER BY ci.created_at ASC`,
      [cartId],
    );
    return res.rows;
  }

  async findCartItemById(cartId: string, itemId: string): Promise<CartItemRow | null> {
    const res = await this.db.query<CartItemRow>(
      `SELECT id, cart_id, listing_id, sku_id, merchant_tenant_id, quantity, created_at, updated_at
       FROM cart_items
       WHERE cart_id = $1 AND id = $2`,
      [cartId, itemId],
    );
    return res.rows[0] ?? null;
  }

  async findCartItemByListing(cartId: string, listingId: string): Promise<CartItemRow | null> {
    const res = await this.db.query<CartItemRow>(
      `SELECT id, cart_id, listing_id, sku_id, merchant_tenant_id, quantity, created_at, updated_at
       FROM cart_items
       WHERE cart_id = $1 AND listing_id = $2`,
      [cartId, listingId],
    );
    return res.rows[0] ?? null;
  }

  async addOrIncrementItem(
    cartId: string,
    listingId: string,
    skuId: string,
    merchantTenantId: string,
    quantity: number,
  ): Promise<CartItemRow> {
    const id = randomUUID();
    const res = await this.db.query<CartItemRow>(
      `INSERT INTO cart_items (id, cart_id, listing_id, sku_id, merchant_tenant_id, quantity)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (cart_id, listing_id)
       DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity,
                     updated_at = CURRENT_TIMESTAMP
       RETURNING id, cart_id, listing_id, sku_id, merchant_tenant_id, quantity, created_at, updated_at`,
      [id, cartId, listingId, skuId, merchantTenantId, quantity],
    );
    return res.rows[0]!;
  }

  async updateItemQuantity(
    cartId: string,
    itemId: string,
    quantity: number,
  ): Promise<CartItemRow | null> {
    if (quantity <= 0) {
      await this.removeItem(cartId, itemId);
      return null;
    }

    const res = await this.db.query<CartItemRow>(
      `UPDATE cart_items
       SET quantity = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE cart_id = $2 AND id = $3
       RETURNING id, cart_id, listing_id, sku_id, merchant_tenant_id, quantity, created_at, updated_at`,
      [quantity, cartId, itemId],
    );
    return res.rows[0] ?? null;
  }

  async removeItem(cartId: string, itemId: string): Promise<boolean> {
    const res = await this.db.query(
      `DELETE FROM cart_items
       WHERE cart_id = $1 AND id = $2`,
      [cartId, itemId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async clearCart(cartId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM cart_items
       WHERE cart_id = $1`,
      [cartId],
    );
  }
}
