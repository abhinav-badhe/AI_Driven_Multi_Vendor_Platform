import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type {
  ProductReviewRow,
  ReviewStatus,
  ProductRatingSummary,
  ListReviewsFilter,
} from './review-models.js';

export class ReviewRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async createReview(
    data: {
      id: string;
      productId: string;
      customerId: string;
      tenantId: string;
      orderId: string | null;
      orderItemId: string | null;
      rating: number;
      title: string | null;
      comment: string;
      reviewerName: string | null;
      reviewerEmail: string | null;
      status: ReviewStatus;
      verifiedPurchase: boolean;
      reviewedAt?: Date | null | undefined;
    },
    client?: DatabaseConnection,
  ): Promise<ProductReviewRow> {
    const conn = client ?? this.db;
    const res = await conn.query<ProductReviewRow>(
      `INSERT INTO product_reviews (
         id, product_id, customer_id, tenant_id, order_id, order_item_id,
         rating, title, comment, reviewer_name, reviewer_email, status,
         verified_purchase, reviewed_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        data.id,
        data.productId,
        data.customerId,
        data.tenantId,
        data.orderId,
        data.orderItemId,
        data.rating,
        data.title,
        data.comment,
        data.reviewerName,
        data.reviewerEmail,
        data.status,
        data.verifiedPurchase,
        data.reviewedAt ?? new Date(),
      ],
    );
    return res.rows[0]!;
  }

  async findReviewById(id: string, client?: DatabaseConnection): Promise<ProductReviewRow | null> {
    const conn = client ?? this.db;
    const res = await conn.query<ProductReviewRow>(
      `SELECT * FROM product_reviews WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findReviewByCustomerAndProduct(
    customerId: string,
    productId: string,
    client?: DatabaseConnection,
  ): Promise<ProductReviewRow | null> {
    const conn = client ?? this.db;
    const res = await conn.query<ProductReviewRow>(
      `SELECT * FROM product_reviews WHERE customer_id = $1 AND product_id = $2`,
      [customerId, productId],
    );
    return res.rows[0] ?? null;
  }

  async listApprovedReviewsByProductId(
    productId: string,
    ownCustomerId?: string | null | undefined,
  ): Promise<ProductReviewRow[]> {
    if (ownCustomerId) {
      // Returns all approved reviews PLUS the authenticated customer's own review even if pending/rejected
      const res = await this.db.query<ProductReviewRow>(
        `SELECT * FROM product_reviews
         WHERE product_id = $1 AND (status = 'APPROVED' OR customer_id = $2)
         ORDER BY (customer_id = $2) DESC, created_at DESC`,
        [productId, ownCustomerId],
      );
      return res.rows;
    }

    const res = await this.db.query<ProductReviewRow>(
      `SELECT * FROM product_reviews
       WHERE product_id = $1 AND status = 'APPROVED'
       ORDER BY created_at DESC`,
      [productId],
    );
    return res.rows;
  }

  async listReviewsByCustomer(customerId: string): Promise<ProductReviewRow[]> {
    const res = await this.db.query<ProductReviewRow>(
      `SELECT * FROM product_reviews
       WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [customerId],
    );
    return res.rows;
  }

  async listReviews(
    filter?: ListReviewsFilter | undefined,
    merchantTenantId?: string | undefined,
  ): Promise<ProductReviewRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filter?.productId) {
      conditions.push(`r.product_id = $${idx++}`);
      params.push(filter.productId);
    }
    if (filter?.status) {
      conditions.push(`r.status = $${idx++}`);
      params.push(filter.status);
    }
    if (filter?.customerId) {
      conditions.push(`r.customer_id = $${idx++}`);
      params.push(filter.customerId);
    }

    if (merchantTenantId) {
      // Restrict to products the merchant has listed
      conditions.push(`r.product_id IN (
        SELECT ps.product_id FROM merchant_listings ml
        JOIN product_skus ps ON ps.id = ml.sku_id
        WHERE ml.tenant_id = $${idx++}
      )`);
      params.push(merchantTenantId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filter?.limit ? `LIMIT ${Number(filter.limit)}` : 'LIMIT 100';
    const offsetClause = filter?.offset ? `OFFSET ${Number(filter.offset)}` : '';

    const query = `
      SELECT r.* FROM product_reviews r
      ${whereClause}
      ORDER BY r.created_at DESC
      ${limitClause} ${offsetClause}
    `;

    const res = await this.db.query<ProductReviewRow>(query, params);
    return res.rows;
  }

  async updateReview(
    id: string,
    updates: Partial<ProductReviewRow>,
    client?: DatabaseConnection,
  ): Promise<ProductReviewRow | null> {
    const conn = client ?? this.db;
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, val] of Object.entries(updates)) {
      if (val !== undefined && key !== 'id' && key !== 'created_at') {
        fields.push(`${key} = $${idx++}`);
        values.push(val);
      }
    }

    if (fields.length === 0) {
      return this.findReviewById(id, conn);
    }

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const query = `
      UPDATE product_reviews
      SET ${fields.join(', ')}
      WHERE id = $${idx}
      RETURNING *
    `;

    const res = await conn.query<ProductReviewRow>(query, values);
    return res.rows[0] ?? null;
  }

  async deleteReview(id: string, client?: DatabaseConnection): Promise<boolean> {
    const conn = client ?? this.db;
    const res = await conn.query(
      `DELETE FROM product_reviews WHERE id = $1`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async calculateRatingSummary(
    productId: string,
    client?: DatabaseConnection,
  ): Promise<ProductRatingSummary> {
    const conn = client ?? this.db;
    const res = await conn.query<{
      total_reviews: string | number;
      average_rating: string | number;
      star_5: string | number;
      star_4: string | number;
      star_3: string | number;
      star_2: string | number;
      star_1: string | number;
    }>(
      `SELECT
         COUNT(*) as total_reviews,
         COALESCE(AVG(rating), 0) as average_rating,
         COALESCE(SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END), 0) as star_5,
         COALESCE(SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END), 0) as star_4,
         COALESCE(SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END), 0) as star_3,
         COALESCE(SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END), 0) as star_2,
         COALESCE(SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END), 0) as star_1
       FROM product_reviews
       WHERE product_id = $1 AND status = 'APPROVED'`,
      [productId],
    );

    const row = res.rows[0];
    const totalReviews = Number(row?.total_reviews ?? 0);
    const rawAvg = Number(row?.average_rating ?? 0);
    const averageRating = totalReviews > 0 ? Math.round(rawAvg * 100) / 100 : 0;

    return {
      productId,
      averageRating,
      totalReviews,
      distribution: {
        5: Number(row?.star_5 ?? 0),
        4: Number(row?.star_4 ?? 0),
        3: Number(row?.star_3 ?? 0),
        2: Number(row?.star_2 ?? 0),
        1: Number(row?.star_1 ?? 0),
      },
    };
  }

  async updateProductRatingMetrics(
    productId: string,
    averageRating: number,
    totalReviews: number,
    client?: DatabaseConnection,
  ): Promise<void> {
    const conn = client ?? this.db;
    await conn.query(
      `UPDATE products
       SET rating = $1, review_count = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [totalReviews > 0 ? averageRating : null, totalReviews, productId],
    );
  }

  async findVerifiedPurchase(
    customerTenantId: string,
    productId: string,
  ): Promise<{ orderId: string; orderItemId: string } | null> {
    const res = await this.db.query<{ order_id: string; order_item_id: string }>(
      `SELECT co.id as order_id, oi.id as order_item_id
       FROM order_items oi
       JOIN customer_orders co ON co.id = oi.customer_order_id
       WHERE co.customer_tenant_id = $1
         AND oi.product_id = $2
         AND co.status IN ('PAID', 'PROCESSING', 'COMPLETED')
       ORDER BY co.created_at DESC
       LIMIT 1`,
      [customerTenantId, productId],
    );

    if (res.rows.length === 0) {
      return null;
    }

    return {
      orderId: res.rows[0]!.order_id,
      orderItemId: res.rows[0]!.order_item_id,
    };
  }

  async isMerchantAuthorizedForProduct(
    merchantTenantId: string,
    productId: string,
  ): Promise<boolean> {
    const res = await this.db.query(
      `SELECT 1 FROM merchant_listings ml
       JOIN product_skus ps ON ps.id = ml.sku_id
       WHERE ml.tenant_id = $1 AND ps.product_id = $2
       LIMIT 1`,
      [merchantTenantId, productId],
    );
    return res.rows.length > 0;
  }
}
