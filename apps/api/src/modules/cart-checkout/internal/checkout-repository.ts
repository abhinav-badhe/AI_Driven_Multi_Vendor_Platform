import type { DatabaseConnection } from '../../../infra/database/connection.js';

export type CheckoutStatus =
  'OPEN' | 'VALIDATING' | 'RESERVED' | 'READY' | 'FAILED' | 'EXPIRED' | 'CANCELLED';

export interface CheckoutSessionRow {
  id: string;
  cart_id: string;
  customer_tenant_id: string;
  status: CheckoutStatus;
  currency: string;
  subtotal_amount: number;
  discount_amount: number;
  shipping_amount: number;
  tax_amount: number;
  total_amount: number;
  idempotency_key: string | null;
  expires_at: Date;
  reserved_at: Date | null;
  cancelled_at: Date | null;
  failed_at: Date | null;
  failure_reason: string | null;
  coupon_code?: string | null;
  applied_promotions?: unknown;
  shipping_address?: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface CheckoutItemRow {
  id: string;
  checkout_session_id: string;
  listing_id: string;
  sku_id: string;
  merchant_tenant_id: string;
  quantity: number;
  unit_price_amount: number;
  line_total_amount: number;
  currency: string;
  inventory_reservation_id: string | null;
  created_at: Date;
  product_id?: string | null | undefined;
  product_title?: string | null | undefined;
  product_brand?: string | null | undefined;
  product_thumbnail_url?: string | null | undefined;
}

export interface CreateCheckoutSessionInput {
  id: string;
  cartId: string;
  customerTenantId: string;
  status?: CheckoutStatus | undefined;
  currency: string;
  subtotalAmount: number;
  discountAmount?: number | undefined;
  shippingAmount?: number | undefined;
  taxAmount?: number | undefined;
  totalAmount: number;
  idempotencyKey?: string | null | undefined;
  expiresAt: Date;
  shippingAddress?: unknown | undefined;
}

export interface CreateCheckoutItemInput {
  id: string;
  checkoutSessionId: string;
  listingId: string;
  skuId: string;
  merchantTenantId: string;
  quantity: number;
  unitPriceAmount: number;
  lineTotalAmount: number;
  currency: string;
  inventoryReservationId?: string | null | undefined;
}

export class CheckoutRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async createSession(data: CreateCheckoutSessionInput): Promise<CheckoutSessionRow> {
    const res = await this.db.query<CheckoutSessionRow>(
      `INSERT INTO checkout_sessions (
        id, cart_id, customer_tenant_id, status, currency,
        subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount,
        idempotency_key, expires_at, shipping_address
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id, cart_id, customer_tenant_id, status, currency,
                subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount,
                idempotency_key, expires_at, reserved_at, cancelled_at, failed_at, failure_reason,
                coupon_code, applied_promotions, shipping_address, created_at, updated_at`,
      [
        data.id,
        data.cartId,
        data.customerTenantId,
        data.status ?? 'OPEN',
        data.currency,
        data.subtotalAmount,
        data.discountAmount ?? 0,
        data.shippingAmount ?? 0,
        data.taxAmount ?? 0,
        data.totalAmount,
        data.idempotencyKey ?? null,
        data.expiresAt,
        data.shippingAddress ? JSON.stringify(data.shippingAddress) : null,
      ],
    );
    return res.rows[0]!;
  }

  async findSessionById(id: string): Promise<CheckoutSessionRow | null> {
    const res = await this.db.query<CheckoutSessionRow>(
      `SELECT id, cart_id, customer_tenant_id, status, currency,
              subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount,
              idempotency_key, expires_at, reserved_at, cancelled_at, failed_at, failure_reason,
              coupon_code, applied_promotions, shipping_address, created_at, updated_at
       FROM checkout_sessions
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findSessionByIdempotency(
    customerTenantId: string,
    idempotencyKey: string,
  ): Promise<CheckoutSessionRow | null> {
    const res = await this.db.query<CheckoutSessionRow>(
      `SELECT id, cart_id, customer_tenant_id, status, currency,
              subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount,
              idempotency_key, expires_at, reserved_at, cancelled_at, failed_at, failure_reason,
              coupon_code, applied_promotions, shipping_address, created_at, updated_at
       FROM checkout_sessions
       WHERE customer_tenant_id = $1 AND idempotency_key = $2`,
      [customerTenantId, idempotencyKey],
    );
    return res.rows[0] ?? null;
  }

  async createCheckoutItems(items: CreateCheckoutItemInput[]): Promise<CheckoutItemRow[]> {
    const created: CheckoutItemRow[] = [];
    for (const item of items) {
      const res = await this.db.query<CheckoutItemRow>(
        `INSERT INTO checkout_items (
          id, checkout_session_id, listing_id, sku_id, merchant_tenant_id,
          quantity, unit_price_amount, line_total_amount, currency, inventory_reservation_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, checkout_session_id, listing_id, sku_id, merchant_tenant_id,
                  quantity, unit_price_amount, line_total_amount, currency, inventory_reservation_id,
                  created_at`,
        [
          item.id,
          item.checkoutSessionId,
          item.listingId,
          item.skuId,
          item.merchantTenantId,
          item.quantity,
          item.unitPriceAmount,
          item.lineTotalAmount,
          item.currency,
          item.inventoryReservationId ?? null,
        ],
      );
      created.push(res.rows[0]!);
    }
    return created;
  }

  async getCheckoutItems(sessionId: string): Promise<CheckoutItemRow[]> {
    const res = await this.db.query<CheckoutItemRow>(
      `SELECT ci.id, ci.checkout_session_id, ci.listing_id, ci.sku_id, ci.merchant_tenant_id,
              ci.quantity, ci.unit_price_amount, ci.line_total_amount, ci.currency,
              ci.inventory_reservation_id, ci.created_at,
              p.id AS product_id, p.title AS product_title,
              p.brand AS product_brand, p.thumbnail_url AS product_thumbnail_url
       FROM checkout_items ci
       LEFT JOIN product_skus s ON s.id = ci.sku_id
       LEFT JOIN products p ON p.id = s.product_id
       WHERE ci.checkout_session_id = $1
       ORDER BY ci.created_at ASC`,
      [sessionId],
    );
    return res.rows;
  }

  async updateSessionStatus(
    id: string,
    currentStatus: CheckoutStatus | CheckoutStatus[],
    nextStatus: CheckoutStatus,
    extra?:
      | {
          failureReason?: string | null | undefined;
          reservedAt?: Date | undefined;
          cancelledAt?: Date | undefined;
          failedAt?: Date | undefined;
        }
      | undefined,
  ): Promise<CheckoutSessionRow | null> {
    const allowed = Array.isArray(currentStatus) ? currentStatus : [currentStatus];
    const params: unknown[] = [id, nextStatus];

    let query = `UPDATE checkout_sessions SET status = $2, updated_at = CURRENT_TIMESTAMP`;

    if (extra?.failureReason !== undefined) {
      params.push(extra.failureReason);
      query += `, failure_reason = $${params.length}`;
    }
    if (extra?.reservedAt !== undefined) {
      params.push(extra.reservedAt);
      query += `, reserved_at = $${params.length}`;
    }
    if (extra?.cancelledAt !== undefined) {
      params.push(extra.cancelledAt);
      query += `, cancelled_at = $${params.length}`;
    }
    if (extra?.failedAt !== undefined) {
      params.push(extra.failedAt);
      query += `, failed_at = $${params.length}`;
    }

    const statusPlaceholders = allowed
      .map((s) => {
        params.push(s);
        return `$${params.length}`;
      })
      .join(', ');

    query += ` WHERE id = $1 AND status IN (${statusPlaceholders})
      RETURNING id, cart_id, customer_tenant_id, status, currency,
                subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount,
                idempotency_key, expires_at, reserved_at, cancelled_at, failed_at, failure_reason,
                coupon_code, applied_promotions, shipping_address, created_at, updated_at`;

    const res = await this.db.query<CheckoutSessionRow>(query, params);
    return res.rows[0] ?? null;
  }

  async updateShippingAddress(
    id: string,
    shippingAddress: unknown,
  ): Promise<CheckoutSessionRow | null> {
    const res = await this.db.query<CheckoutSessionRow>(
      `UPDATE checkout_sessions
       SET shipping_address = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, cart_id, customer_tenant_id, status, currency,
                 subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount,
                 idempotency_key, expires_at, reserved_at, cancelled_at, failed_at, failure_reason,
                 coupon_code, applied_promotions, shipping_address, created_at, updated_at`,
      [id, shippingAddress ? JSON.stringify(shippingAddress) : null],
    );
    return res.rows[0] ?? null;
  }

  async setCheckoutItemReservation(itemId: string, reservationId: string | null): Promise<void> {
    await this.db.query(
      `UPDATE checkout_items
       SET inventory_reservation_id = $1
       WHERE id = $2`,
      [reservationId, itemId],
    );
  }

  async claimValidationRecovery(
    id: string,
    claimToken: string,
    staleCutoff: Date,
  ): Promise<CheckoutSessionRow | null> {
    const res = await this.db.query<CheckoutSessionRow>(
      `UPDATE checkout_sessions
       SET updated_at = CURRENT_TIMESTAMP, failure_reason = $2
       WHERE id = $1
          AND status = 'VALIDATING'
          AND (failure_reason IS NULL OR failure_reason NOT LIKE 'RECOVERY_CLAIM:%' OR updated_at < $3)
       RETURNING id, cart_id, customer_tenant_id, status, currency,
                 subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount,
                 idempotency_key, expires_at, reserved_at, cancelled_at, failed_at, failure_reason,
                 coupon_code, applied_promotions, shipping_address, created_at, updated_at`,
      [id, `RECOVERY_CLAIM:${claimToken}`, staleCutoff],
    );
    return res.rows[0] ?? null;
  }
}
