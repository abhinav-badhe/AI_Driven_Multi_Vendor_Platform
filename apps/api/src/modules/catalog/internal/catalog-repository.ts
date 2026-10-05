import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';

export type ProductStatus = 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
export type SkuStatus = 'DRAFT' | 'ACTIVE' | 'INACTIVE';

export interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductRow {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  brand: string | null;
  category_id: string | null;
  status: ProductStatus;
  thumbnail_url: string | null;
  images: unknown;
  rating: string | number | null;
  review_count: string | number | null;
  attributes: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProductReviewRow {
  id: string;
  product_id: string;
  rating: number;
  comment: string | null;
  reviewer_name: string | null;
  reviewer_email: string | null;
  reviewed_at: string | null;
  created_at: string;
}

// Columns for enriched product reads (Catalog owns this display content).
const PRODUCT_COLUMNS = `
  id, title, slug, description, brand, category_id, status,
  thumbnail_url, images, rating, review_count, attributes,
  created_at, updated_at
`;

export interface ProductSkuRow {
  id: string;
  product_id: string;
  sku_code: string;
  barcode: string | null;
  attributes: Record<string, unknown>;
  status: SkuStatus;
  created_at: string;
  updated_at: string;
}

export interface ListProductsFilter {
  categoryId?: string | undefined;
  status?: ProductStatus | undefined;
  search?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export class CatalogRepository {
  constructor(private readonly db: DatabaseConnection) {}

  // --- Category Methods ---

  async createCategory(data: {
    id?: string | undefined;
    name: string;
    slug: string;
    parentId?: string | null | undefined;
  }): Promise<CategoryRow> {
    const id = data.id ?? randomUUID();
    const res = await this.db.query<CategoryRow>(
      `INSERT INTO categories (id, name, slug, parent_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, slug, parent_id, created_at, updated_at`,
      [id, data.name, data.slug, data.parentId ?? null],
    );
    return res.rows[0]!;
  }

  async findCategoryById(id: string): Promise<CategoryRow | null> {
    const res = await this.db.query<CategoryRow>(
      `SELECT id, name, slug, parent_id, created_at, updated_at
       FROM categories
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findCategoryBySlug(slug: string): Promise<CategoryRow | null> {
    const res = await this.db.query<CategoryRow>(
      `SELECT id, name, slug, parent_id, created_at, updated_at
       FROM categories
       WHERE slug = $1`,
      [slug],
    );
    return res.rows[0] ?? null;
  }

  async listCategories(): Promise<CategoryRow[]> {
    const res = await this.db.query<CategoryRow>(
      `SELECT id, name, slug, parent_id, created_at, updated_at
       FROM categories
       ORDER BY name ASC`,
    );
    return res.rows;
  }

  // --- Product Methods ---

  async createProduct(data: {
    id?: string | undefined;
    title: string;
    slug: string;
    description?: string | null | undefined;
    brand?: string | null | undefined;
    categoryId?: string | null | undefined;
    status?: ProductStatus | undefined;
    thumbnailUrl?: string | null | undefined;
    images?: unknown | undefined;
    rating?: number | null | undefined;
    reviewCount?: number | undefined;
    attributes?: Record<string, unknown> | undefined;
  }): Promise<ProductRow> {
    const id = data.id ?? randomUUID();
    const status = data.status ?? 'DRAFT';
    const res = await this.db.query<ProductRow>(
      `INSERT INTO products (id, title, slug, description, brand, category_id, status,
        thumbnail_url, images, rating, review_count, attributes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${PRODUCT_COLUMNS}`,
      [
        id,
        data.title,
        data.slug,
        data.description ?? null,
        data.brand ?? null,
        data.categoryId ?? null,
        status,
        data.thumbnailUrl ?? null,
        JSON.stringify(data.images ?? []),
        data.rating ?? null,
        data.reviewCount ?? 0,
        JSON.stringify(data.attributes ?? {}),
      ],
    );
    return res.rows[0]!;
  }

  async findProductById(id: string): Promise<ProductRow | null> {
    const res = await this.db.query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS}
       FROM products
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findProductBySlug(slug: string): Promise<ProductRow | null> {
    const res = await this.db.query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS}
       FROM products
       WHERE slug = $1`,
      [slug],
    );
    return res.rows[0] ?? null;
  }

  async updateProduct(
    id: string,
    updates: {
      title?: string | undefined;
      slug?: string | undefined;
      description?: string | null | undefined;
      brand?: string | null | undefined;
      categoryId?: string | null | undefined;
      status?: ProductStatus | undefined;
      thumbnailUrl?: string | null | undefined;
      images?: unknown | undefined;
      rating?: number | null | undefined;
      reviewCount?: number | undefined;
      attributes?: Record<string, unknown> | undefined;
    },
  ): Promise<ProductRow | null> {
    const current = await this.findProductById(id);
    if (!current) return null;

    const title = updates.title !== undefined ? updates.title : current.title;
    const slug = updates.slug !== undefined ? updates.slug : current.slug;
    const description = updates.description !== undefined ? updates.description : current.description;
    const brand = updates.brand !== undefined ? updates.brand : current.brand;
    const categoryId = updates.categoryId !== undefined ? updates.categoryId : current.category_id;
    const status = updates.status !== undefined ? updates.status : current.status;
    const thumbnailUrl =
      updates.thumbnailUrl !== undefined ? updates.thumbnailUrl : current.thumbnail_url;
    const images =
      updates.images !== undefined
        ? JSON.stringify(updates.images)
        : typeof current.images === 'string'
          ? current.images
          : JSON.stringify(current.images ?? []);
    const rating = updates.rating !== undefined ? updates.rating : current.rating;
    const reviewCount =
      updates.reviewCount !== undefined ? updates.reviewCount : current.review_count;
    const attributes =
      updates.attributes !== undefined
        ? JSON.stringify(updates.attributes)
        : typeof current.attributes === 'string'
          ? current.attributes
          : JSON.stringify(current.attributes ?? {});

    const res = await this.db.query<ProductRow>(
      `UPDATE products
       SET title = $1, slug = $2, description = $3, brand = $4, category_id = $5, status = $6,
           thumbnail_url = $7, images = $8, rating = $9, review_count = $10, attributes = $11,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $12
       RETURNING ${PRODUCT_COLUMNS}`,
      [title, slug, description, brand, categoryId, status, thumbnailUrl, images, rating, reviewCount, attributes, id],
    );
    return res.rows[0] ?? null;
  }

  async listProducts(filter?: ListProductsFilter): Promise<ProductRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filter?.categoryId) {
      conditions.push(`category_id = $${paramIndex++}`);
      params.push(filter.categoryId);
    }

    if (filter?.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filter.status);
    }

    if (filter?.search) {
      conditions.push(`(title ILIKE $${paramIndex} OR brand ILIKE $${paramIndex})`);
      params.push(`%${filter.search}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;

    params.push(limit);
    const limitParam = `$${paramIndex++}`;
    params.push(offset);
    const offsetParam = `$${paramIndex++}`;

    const res = await this.db.query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS}
       FROM products
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    );
    return res.rows;
  }

  // --- Product Review Methods ---

  async createReview(data: {
    id?: string | undefined;
    productId: string;
    rating: number;
    comment?: string | null | undefined;
    reviewerName?: string | null | undefined;
    reviewerEmail?: string | null | undefined;
    reviewedAt?: string | null | undefined;
  }): Promise<ProductReviewRow> {
    const id = data.id ?? randomUUID();
    const res = await this.db.query<ProductReviewRow>(
      `INSERT INTO product_reviews (id, product_id, rating, comment, reviewer_name, reviewer_email, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, product_id, rating, comment, reviewer_name, reviewer_email, reviewed_at, created_at`,
      [
        id,
        data.productId,
        data.rating,
        data.comment ?? null,
        data.reviewerName ?? null,
        data.reviewerEmail ?? null,
        data.reviewedAt ?? null,
      ],
    );
    return res.rows[0]!;
  }

  async listReviewsByProductId(productId: string): Promise<ProductReviewRow[]> {
    const res = await this.db.query<ProductReviewRow>(
      `SELECT id, product_id, rating, comment, reviewer_name, reviewer_email, reviewed_at, created_at
       FROM product_reviews
       WHERE product_id = $1
       ORDER BY reviewed_at DESC NULLS LAST, created_at DESC`,
      [productId],
    );
    return res.rows;
  }

  async deleteReviewsByProductId(productId: string): Promise<number> {
    const res = await this.db.query(
      `DELETE FROM product_reviews WHERE product_id = $1`,
      [productId],
    );
    return res.rowCount ?? 0;
  }

  // --- SKU Methods ---

  async createSku(data: {
    id?: string | undefined;
    productId: string;
    skuCode: string;
    barcode?: string | null | undefined;
    attributes?: Record<string, unknown> | undefined;
    status?: SkuStatus | undefined;
  }): Promise<ProductSkuRow> {
    const id = data.id ?? randomUUID();
    const status = data.status ?? 'DRAFT';
    const attributes = data.attributes ?? {};
    const res = await this.db.query<ProductSkuRow>(
      `INSERT INTO product_skus (id, product_id, sku_code, barcode, attributes, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, product_id, sku_code, barcode, attributes, status, created_at, updated_at`,
      [
        id,
        data.productId,
        data.skuCode,
        data.barcode ?? null,
        JSON.stringify(attributes),
        status,
      ],
    );
    return res.rows[0]!;
  }

  async findSkuById(id: string): Promise<ProductSkuRow | null> {
    const res = await this.db.query<ProductSkuRow>(
      `SELECT id, product_id, sku_code, barcode, attributes, status, created_at, updated_at
       FROM product_skus
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findSkuByCode(skuCode: string): Promise<ProductSkuRow | null> {
    const res = await this.db.query<ProductSkuRow>(
      `SELECT id, product_id, sku_code, barcode, attributes, status, created_at, updated_at
       FROM product_skus
       WHERE sku_code = $1`,
      [skuCode],
    );
    return res.rows[0] ?? null;
  }

  async findSkusByProductId(productId: string): Promise<ProductSkuRow[]> {
    const res = await this.db.query<ProductSkuRow>(
      `SELECT id, product_id, sku_code, barcode, attributes, status, created_at, updated_at
       FROM product_skus
       WHERE product_id = $1
       ORDER BY sku_code ASC`,
      [productId],
    );
    return res.rows;
  }

  async updateSku(
    id: string,
    updates: {
      skuCode?: string | undefined;
      barcode?: string | null | undefined;
      attributes?: Record<string, unknown> | undefined;
      status?: SkuStatus | undefined;
    },
  ): Promise<ProductSkuRow | null> {
    const current = await this.findSkuById(id);
    if (!current) return null;

    const skuCode = updates.skuCode !== undefined ? updates.skuCode : current.sku_code;
    const barcode = updates.barcode !== undefined ? updates.barcode : current.barcode;
    const attributes =
      updates.attributes !== undefined
        ? JSON.stringify(updates.attributes)
        : typeof current.attributes === 'string'
          ? current.attributes
          : JSON.stringify(current.attributes);
    const status = updates.status !== undefined ? updates.status : current.status;

    const res = await this.db.query<ProductSkuRow>(
      `UPDATE product_skus
       SET sku_code = $1, barcode = $2, attributes = $3, status = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING id, product_id, sku_code, barcode, attributes, status, created_at, updated_at`,
      [skuCode, barcode, attributes, status, id],
    );
    return res.rows[0] ?? null;
  }
}
