import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type {
  PromotionRow,
  CouponRedemptionRow,
  CreatePromotionInput,
  UpdatePromotionInput,
  PromotionStatus,
  RedemptionStatus,
} from './promotion-models.js';

export class PromotionRepository {
  constructor(_db?: DatabaseConnection) {}

  async createPromotion(
    conn: DatabaseConnection,
    data: CreatePromotionInput & { id: string },
  ): Promise<PromotionRow> {
    const res = await conn.query<PromotionRow>(
      `INSERT INTO promotions (
        id, name, description, merchant_tenant_id, code,
        discount_type, discount_value, currency, scope, target_ids,
        min_order_amount, max_discount_amount, starts_at, expires_at,
        status, usage_limit_total, usage_limit_per_customer,
        current_usage_count, first_order_only, stackable, metadata
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10::jsonb,
        $11, $12, $13, $14,
        $15, $16, $17,
        0, $18, $19, $20::jsonb
      ) RETURNING *`,
      [
        data.id,
        data.name,
        data.description ?? null,
        data.merchantTenantId ?? null,
        data.code ? data.code.trim().toUpperCase() : null,
        data.discountType,
        data.discountValue,
        (data.currency ?? 'USD').toUpperCase(),
        data.scope ?? 'ORDER',
        JSON.stringify(data.targetIds ?? []),
        data.minOrderAmount ?? 0,
        data.maxDiscountAmount ?? null,
        new Date(data.startsAt),
        data.expiresAt ? new Date(data.expiresAt) : null,
        data.status ?? 'ACTIVE',
        data.usageLimitTotal ?? null,
        data.usageLimitPerCustomer ?? null,
        data.firstOrderOnly ?? false,
        data.stackable ?? false,
        JSON.stringify(data.metadata ?? {}),
      ],
    );
    return this.mapRow(res.rows[0]!);
  }

  async updatePromotion(
    conn: DatabaseConnection,
    id: string,
    data: UpdatePromotionInput,
  ): Promise<PromotionRow | null> {
    const updates: string[] = [];
    const values: unknown[] = [id];
    let idx = 2;

    if (data.name !== undefined) {
      updates.push(`name = $${idx++}`);
      values.push(data.name);
    }
    if (data.description !== undefined) {
      updates.push(`description = $${idx++}`);
      values.push(data.description);
    }
    if (data.discountType !== undefined) {
      updates.push(`discount_type = $${idx++}`);
      values.push(data.discountType);
    }
    if (data.discountValue !== undefined) {
      updates.push(`discount_value = $${idx++}`);
      values.push(data.discountValue);
    }
    if (data.currency !== undefined) {
      updates.push(`currency = $${idx++}`);
      values.push(data.currency.toUpperCase());
    }
    if (data.scope !== undefined) {
      updates.push(`scope = $${idx++}`);
      values.push(data.scope);
    }
    if (data.targetIds !== undefined) {
      updates.push(`target_ids = $${idx++}::jsonb`);
      values.push(JSON.stringify(data.targetIds));
    }
    if (data.minOrderAmount !== undefined) {
      updates.push(`min_order_amount = $${idx++}`);
      values.push(data.minOrderAmount);
    }
    if (data.maxDiscountAmount !== undefined) {
      updates.push(`max_discount_amount = $${idx++}`);
      values.push(data.maxDiscountAmount);
    }
    if (data.startsAt !== undefined) {
      updates.push(`starts_at = $${idx++}`);
      values.push(new Date(data.startsAt));
    }
    if (data.expiresAt !== undefined) {
      updates.push(`expires_at = $${idx++}`);
      values.push(data.expiresAt ? new Date(data.expiresAt) : null);
    }
    if (data.status !== undefined) {
      updates.push(`status = $${idx++}`);
      values.push(data.status);
    }
    if (data.usageLimitTotal !== undefined) {
      updates.push(`usage_limit_total = $${idx++}`);
      values.push(data.usageLimitTotal);
    }
    if (data.usageLimitPerCustomer !== undefined) {
      updates.push(`usage_limit_per_customer = $${idx++}`);
      values.push(data.usageLimitPerCustomer);
    }
    if (data.firstOrderOnly !== undefined) {
      updates.push(`first_order_only = $${idx++}`);
      values.push(data.firstOrderOnly);
    }
    if (data.stackable !== undefined) {
      updates.push(`stackable = $${idx++}`);
      values.push(data.stackable);
    }
    if (data.metadata !== undefined) {
      updates.push(`metadata = $${idx++}::jsonb`);
      values.push(JSON.stringify(data.metadata));
    }

    if (updates.length === 0) {
      return this.getPromotionById(conn, id);
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);

    const sql = `UPDATE promotions SET ${updates.join(', ')} WHERE id = $1 RETURNING *`;
    const res = await conn.query<PromotionRow>(sql, values);
    if (!res.rows[0]) return null;
    return this.mapRow(res.rows[0]);
  }

  async getPromotionById(conn: DatabaseConnection, id: string): Promise<PromotionRow | null> {
    const res = await conn.query<PromotionRow>(`SELECT * FROM promotions WHERE id = $1`, [id]);
    if (!res.rows[0]) return null;
    return this.mapRow(res.rows[0]);
  }

  async getPromotionByCode(conn: DatabaseConnection, code: string): Promise<PromotionRow | null> {
    const trimmed = code.trim().toUpperCase();
    const res = await conn.query<PromotionRow>(
      `SELECT * FROM promotions WHERE UPPER(code) = $1`,
      [trimmed],
    );
    if (!res.rows[0]) return null;
    return this.mapRow(res.rows[0]);
  }

  async lockPromotionForUpdate(conn: DatabaseConnection, id: string): Promise<PromotionRow | null> {
    const res = await conn.query<PromotionRow>(
      `SELECT * FROM promotions WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!res.rows[0]) return null;
    return this.mapRow(res.rows[0]);
  }

  async incrementUsageCount(conn: DatabaseConnection, id: string): Promise<number> {
    const res = await conn.query<{ current_usage_count: number }>(
      `UPDATE promotions
       SET current_usage_count = current_usage_count + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING current_usage_count`,
      [id],
    );
    return res.rows[0]?.current_usage_count ?? 0;
  }

  async decrementUsageCount(conn: DatabaseConnection, id: string): Promise<number> {
    const res = await conn.query<{ current_usage_count: number }>(
      `UPDATE promotions
       SET current_usage_count = GREATEST(0, current_usage_count - 1),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING current_usage_count`,
      [id],
    );
    return res.rows[0]?.current_usage_count ?? 0;
  }

  async listPromotions(
    conn: DatabaseConnection,
    filters: {
      merchantTenantId?: string | null | undefined;
      includePlatform?: boolean | undefined;
      status?: PromotionStatus | undefined;
      limit?: number | undefined;
      offset?: number | undefined;
    },
  ): Promise<PromotionRow[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (filters.merchantTenantId !== undefined) {
      if (filters.includePlatform) {
        conditions.push(`(merchant_tenant_id = $${idx++} OR merchant_tenant_id IS NULL)`);
        values.push(filters.merchantTenantId);
      } else if (filters.merchantTenantId === null) {
        conditions.push(`merchant_tenant_id IS NULL`);
      } else {
        conditions.push(`merchant_tenant_id = $${idx++}`);
        values.push(filters.merchantTenantId);
      }
    }

    if (filters.status) {
      conditions.push(`status = $${idx++}`);
      values.push(filters.status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    values.push(limit, offset);
    const sql = `SELECT * FROM promotions ${whereClause} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;

    const res = await conn.query<PromotionRow>(sql, values);
    return res.rows.map((r) => this.mapRow(r));
  }

  async findActivePromotionsForItems(
    conn: DatabaseConnection,
    currency: string,
    merchantTenantIds: string[],
    now: Date = new Date(),
  ): Promise<PromotionRow[]> {
    // Finds active automatic promotions (code IS NULL) that apply platform-wide or to these merchants
    const merchantClause =
      merchantTenantIds.length > 0
        ? `(merchant_tenant_id IS NULL OR merchant_tenant_id = ANY($2::text[]))`
        : `merchant_tenant_id IS NULL`;

    const res = await conn.query<PromotionRow>(
      `SELECT * FROM promotions
       WHERE status = 'ACTIVE'
         AND code IS NULL
         AND UPPER(currency) = UPPER($1)
         AND starts_at <= $3
         AND (expires_at IS NULL OR expires_at >= $3)
         AND ${merchantClause}
       ORDER BY created_at ASC`,
      merchantTenantIds.length > 0 ? [currency, merchantTenantIds, now] : [currency, now],
    );

    return res.rows.map((r) => this.mapRow(r));
  }

  async getCustomerRedemptionCount(
    conn: DatabaseConnection,
    promotionId: string,
    customerTenantId: string,
  ): Promise<number> {
    const res = await conn.query<{ count: string | number }>(
      `SELECT COUNT(*) as count
       FROM coupon_redemptions
       WHERE promotion_id = $1
         AND customer_tenant_id = $2
         AND status IN ('RESERVED', 'COMPLETED')`,
      [promotionId, customerTenantId],
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  async getCustomerCompletedOrderCount(
    conn: DatabaseConnection,
    customerTenantId: string,
  ): Promise<number> {
    const res = await conn.query<{ count: string | number }>(
      `SELECT COUNT(*) as count
       FROM customer_orders
       WHERE customer_tenant_id = $1
         AND status != 'CANCELLED'`,
      [customerTenantId],
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  async recordRedemption(
    conn: DatabaseConnection,
    data: {
      id: string;
      promotionId: string;
      couponCode?: string | null;
      checkoutSessionId: string;
      customerOrderId?: string | null;
      customerTenantId: string;
      merchantTenantId?: string | null;
      discountAmount: number;
      currency: string;
      status?: RedemptionStatus;
    },
  ): Promise<CouponRedemptionRow> {
    const res = await conn.query<CouponRedemptionRow>(
      `INSERT INTO coupon_redemptions (
        id, promotion_id, coupon_code, checkout_session_id, customer_order_id,
        customer_tenant_id, merchant_tenant_id, discount_amount, currency, status
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10
      )
      ON CONFLICT (checkout_session_id, promotion_id)
      DO UPDATE SET
        discount_amount = EXCLUDED.discount_amount,
        status = EXCLUDED.status,
        customer_order_id = COALESCE(EXCLUDED.customer_order_id, coupon_redemptions.customer_order_id),
        updated_at = CURRENT_TIMESTAMP
      RETURNING *`,
      [
        data.id,
        data.promotionId,
        data.couponCode ?? null,
        data.checkoutSessionId,
        data.customerOrderId ?? null,
        data.customerTenantId,
        data.merchantTenantId ?? null,
        data.discountAmount,
        data.currency.toUpperCase(),
        data.status ?? 'RESERVED',
      ],
    );
    return res.rows[0]!;
  }

  async updateRedemptionStatus(
    conn: DatabaseConnection,
    checkoutSessionId: string,
    promotionId: string,
    status: RedemptionStatus,
    customerOrderId?: string | null,
  ): Promise<CouponRedemptionRow | null> {
    const res = await conn.query<CouponRedemptionRow>(
      `UPDATE coupon_redemptions
       SET status = $1,
           customer_order_id = COALESCE($2, customer_order_id),
           updated_at = CURRENT_TIMESTAMP
       WHERE checkout_session_id = $3
         AND promotion_id = $4
       RETURNING *`,
      [status, customerOrderId ?? null, checkoutSessionId, promotionId],
    );
    return res.rows[0] ?? null;
  }

  async getRedemptionsByCheckout(
    conn: DatabaseConnection,
    checkoutSessionId: string,
  ): Promise<CouponRedemptionRow[]> {
    const res = await conn.query<CouponRedemptionRow>(
      `SELECT * FROM coupon_redemptions WHERE checkout_session_id = $1`,
      [checkoutSessionId],
    );
    return res.rows;
  }

  private mapRow(row: PromotionRow): PromotionRow {
    return {
      ...row,
      discount_value: Number(row.discount_value),
      min_order_amount: Number(row.min_order_amount),
      max_discount_amount: row.max_discount_amount !== null ? Number(row.max_discount_amount) : null,
      current_usage_count: Number(row.current_usage_count),
      usage_limit_total: row.usage_limit_total !== null ? Number(row.usage_limit_total) : null,
      usage_limit_per_customer:
        row.usage_limit_per_customer !== null ? Number(row.usage_limit_per_customer) : null,
      first_order_only: Boolean(row.first_order_only),
      stackable: Boolean(row.stackable),
      target_ids: typeof row.target_ids === 'string' ? JSON.parse(row.target_ids) : row.target_ids ?? [],
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata ?? {},
    };
  }
}
