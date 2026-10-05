import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { AuthorizedActor } from '../../identity/index.js';
import { RbacPolicy } from '../../identity/index.js';
import {
  CatalogRepository,
  type CategoryRow,
  type ProductRow,
  type ProductReviewRow,
  type ProductSkuRow,
  type ProductStatus,
  type SkuStatus,
  type ListProductsFilter,
} from './catalog-repository.js';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';

// Domain-enforced product lifecycle transitions
const ALLOWED_PRODUCT_TRANSITIONS: Record<ProductStatus, ProductStatus[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['INACTIVE', 'ARCHIVED'],
  INACTIVE: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [],
};

// Domain-enforced SKU lifecycle transitions
const ALLOWED_SKU_TRANSITIONS: Record<SkuStatus, SkuStatus[]> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['INACTIVE'],
  INACTIVE: ['ACTIVE'],
};

export interface CategoryDto {
  id: string;
  name: string;
  slug: string;
  parentId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductDto {
  id: string;
  title: string;
  slug: string;
  description?: string | null;
  brand?: string | null;
  categoryId?: string | null;
  status: ProductStatus;
  thumbnailUrl?: string | null;
  images: string[];
  rating?: number | null;
  reviewCount: number;
  attributes: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProductReviewDto {
  id: string;
  productId: string;
  rating: number;
  comment?: string | null;
  reviewerName?: string | null;
  reviewerEmail?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
}

export interface ProductSkuDto {
  id: string;
  productId: string;
  skuCode: string;
  barcode?: string | null;
  attributes: Record<string, unknown>;
  status: SkuStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCategoryInput {
  name: string;
  slug: string;
  parentId?: string | null | undefined;
}

export interface CreateProductInput {
  title: string;
  slug: string;
  description?: string | null | undefined;
  brand?: string | null | undefined;
  categoryId?: string | null | undefined;
  thumbnailUrl?: string | null | undefined;
  images?: string[] | undefined;
  attributes?: Record<string, unknown> | undefined;
}

export interface UpdateProductInput {
  title?: string | undefined;
  slug?: string | undefined;
  description?: string | null | undefined;
  brand?: string | null | undefined;
  categoryId?: string | null | undefined;
  thumbnailUrl?: string | null | undefined;
  images?: string[] | undefined;
  attributes?: Record<string, unknown> | undefined;
}

export interface CreateSkuInput {
  skuCode: string;
  barcode?: string | null | undefined;
  attributes?: Record<string, unknown> | undefined;
}

export interface UpdateSkuInput {
  skuCode?: string | undefined;
  barcode?: string | null | undefined;
  attributes?: Record<string, unknown> | undefined;
}

export class CatalogService {
  private readonly repo: CatalogRepository;

  constructor(
    db: DatabaseConnection,
    _logger: Logger,
  ) {
    this.repo = new CatalogRepository(db);
  }

  // --- Category Operations ---

  async createCategory(actor: AuthorizedActor, input: CreateCategoryInput): Promise<CategoryDto> {
    RbacPolicy.requirePermission(actor, 'catalog:create');

    const name = input.name?.trim();
    if (!name) throw new ValidationError('Category name is required');

    const slug = input.slug?.toLowerCase().trim();
    if (!slug) throw new ValidationError('Category slug is required');

    if (input.parentId) {
      const parent = await this.repo.findCategoryById(input.parentId);
      if (!parent) throw new NotFoundError(`Parent category '${input.parentId}' not found`);
    }

    const existingSlug = await this.repo.findCategoryBySlug(slug);
    if (existingSlug) {
      throw new ConflictError(`Category with slug '${slug}' already exists`);
    }

    const row = await this.repo.createCategory({
      name,
      slug,
      parentId: input.parentId ?? null,
    });

    return this.toCategoryDto(row);
  }

  async listCategories(): Promise<CategoryDto[]> {
    const rows = await this.repo.listCategories();
    return rows.map((r) => this.toCategoryDto(r));
  }

  async getCategoryById(id: string): Promise<CategoryDto> {
    const row = await this.repo.findCategoryById(id);
    if (!row) throw new NotFoundError(`Category '${id}' not found`);
    return this.toCategoryDto(row);
  }

  // --- Product Operations ---

  async createProduct(actor: AuthorizedActor, input: CreateProductInput): Promise<ProductDto> {
    RbacPolicy.requirePermission(actor, 'catalog:create');

    const title = input.title?.trim();
    if (!title) throw new ValidationError('Product title is required');

    const slug = input.slug?.toLowerCase().trim();
    if (!slug) throw new ValidationError('Product slug is required');

    if (input.categoryId) {
      const category = await this.repo.findCategoryById(input.categoryId);
      if (!category) throw new NotFoundError(`Category '${input.categoryId}' not found`);
    }

    const existingSlug = await this.repo.findProductBySlug(slug);
    if (existingSlug) {
      throw new ConflictError(`Product with slug '${slug}' already exists`);
    }

    const row = await this.repo.createProduct({
      title,
      slug,
      description: input.description?.trim() ?? null,
      brand: input.brand?.trim() ?? null,
      categoryId: input.categoryId ?? null,
      status: 'DRAFT',
      thumbnailUrl: input.thumbnailUrl?.trim() || null,
      images: input.images ?? [],
      attributes: input.attributes ?? {},
    });

    return this.toProductDto(row);
  }

  async getProductById(id: string): Promise<ProductDto> {
    const row = await this.repo.findProductById(id);
    if (!row) throw new NotFoundError(`Product '${id}' not found`);
    return this.toProductDto(row);
  }

  async updateProduct(
    actor: AuthorizedActor,
    id: string,
    updates: UpdateProductInput,
  ): Promise<ProductDto> {
    RbacPolicy.requirePermission(actor, 'catalog:update');

    const current = await this.repo.findProductById(id);
    if (!current) throw new NotFoundError(`Product '${id}' not found`);

    if (current.status === 'ARCHIVED') {
      throw new InvalidStateTransitionError('Cannot update an ARCHIVED product');
    }

    if (updates.categoryId) {
      const category = await this.repo.findCategoryById(updates.categoryId);
      if (!category) throw new NotFoundError(`Category '${updates.categoryId}' not found`);
    }

    if (updates.slug) {
      const slug = updates.slug.toLowerCase().trim();
      const existingSlug = await this.repo.findProductBySlug(slug);
      if (existingSlug && existingSlug.id !== id) {
        throw new ConflictError(`Product with slug '${slug}' already exists`);
      }
    }

    const updated = await this.repo.updateProduct(id, {
      title: updates.title?.trim(),
      slug: updates.slug?.toLowerCase().trim(),
      description: updates.description?.trim(),
      brand: updates.brand?.trim(),
      categoryId: updates.categoryId,
      thumbnailUrl: updates.thumbnailUrl?.trim(),
      images: updates.images,
      attributes: updates.attributes,
    });

    if (!updated) throw new NotFoundError(`Product '${id}' not found`);
    return this.toProductDto(updated);
  }

  async setProductStatus(
    actor: AuthorizedActor,
    id: string,
    newStatus: ProductStatus,
  ): Promise<ProductDto> {
    RbacPolicy.requirePermission(actor, 'catalog:status');

    const current = await this.repo.findProductById(id);
    if (!current) throw new NotFoundError(`Product '${id}' not found`);

    const allowed = ALLOWED_PRODUCT_TRANSITIONS[current.status];
    if (!allowed.includes(newStatus)) {
      throw new InvalidStateTransitionError(
        `Invalid product status transition from '${current.status}' to '${newStatus}'`,
      );
    }

    const updated = await this.repo.updateProduct(id, { status: newStatus });
    if (!updated) throw new NotFoundError(`Product '${id}' not found`);

    return this.toProductDto(updated);
  }

  async listProducts(filter?: ListProductsFilter): Promise<ProductDto[]> {
    const rows = await this.repo.listProducts(filter);
    return rows.map((r) => this.toProductDto(r));
  }

  async listProductReviews(productId: string): Promise<ProductReviewDto[]> {
    const product = await this.repo.findProductById(productId);
    if (!product) throw new NotFoundError(`Product '${productId}' not found`);
    const rows = await this.repo.listReviewsByProductId(productId);
    return rows.map((r) => this.toReviewDto(r));
  }

  // --- SKU Operations ---

  async createSku(
    actor: AuthorizedActor,
    productId: string,
    input: CreateSkuInput,
  ): Promise<ProductSkuDto> {
    RbacPolicy.requirePermission(actor, 'catalog:create');

    const product = await this.repo.findProductById(productId);
    if (!product) throw new NotFoundError(`Product '${productId}' not found`);

    if (product.status === 'ARCHIVED') {
      throw new InvalidStateTransitionError('Cannot add SKU to an ARCHIVED product');
    }

    const skuCode = input.skuCode?.toUpperCase().trim();
    if (!skuCode) throw new ValidationError('SKU code is required');

    const existingSku = await this.repo.findSkuByCode(skuCode);
    if (existingSku) {
      throw new ConflictError(`SKU with code '${skuCode}' already exists`);
    }

    const row = await this.repo.createSku({
      productId,
      skuCode,
      barcode: input.barcode?.trim() ?? null,
      attributes: input.attributes ?? {},
      status: 'DRAFT',
    });

    return this.toSkuDto(row);
  }

  async getSkuById(id: string): Promise<ProductSkuDto> {
    const row = await this.repo.findSkuById(id);
    if (!row) throw new NotFoundError(`SKU '${id}' not found`);
    return this.toSkuDto(row);
  }

  async listSkusByProduct(productId: string, actor?: AuthorizedActor | null): Promise<ProductSkuDto[]> {
    const product = await this.repo.findProductById(productId);
    if (!product) throw new NotFoundError(`Product '${productId}' not found`);

    let rows = await this.repo.findSkusByProductId(productId);
    
    // Only administrators can see non-active SKUs.
    if (actor?.role !== 'ADMINISTRATOR') {
      rows = rows.filter(r => r.status === 'ACTIVE');
    }
    
    return rows.map((r) => this.toSkuDto(r));
  }

  async updateSku(
    actor: AuthorizedActor,
    id: string,
    updates: UpdateSkuInput,
  ): Promise<ProductSkuDto> {
    RbacPolicy.requirePermission(actor, 'catalog:update');

    const current = await this.repo.findSkuById(id);
    if (!current) throw new NotFoundError(`SKU '${id}' not found`);

    const product = await this.repo.findProductById(current.product_id);
    if (product?.status === 'ARCHIVED') {
      throw new InvalidStateTransitionError('Cannot update SKU of an ARCHIVED product');
    }

    if (updates.skuCode) {
      const skuCode = updates.skuCode.toUpperCase().trim();
      const existing = await this.repo.findSkuByCode(skuCode);
      if (existing && existing.id !== id) {
        throw new ConflictError(`SKU with code '${skuCode}' already exists`);
      }
    }

    const updated = await this.repo.updateSku(id, {
      skuCode: updates.skuCode?.toUpperCase().trim(),
      barcode: updates.barcode?.trim(),
      attributes: updates.attributes,
    });

    if (!updated) throw new NotFoundError(`SKU '${id}' not found`);
    return this.toSkuDto(updated);
  }

  async setSkuStatus(
    actor: AuthorizedActor,
    id: string,
    newStatus: SkuStatus,
  ): Promise<ProductSkuDto> {
    RbacPolicy.requirePermission(actor, 'catalog:status');

    const current = await this.repo.findSkuById(id);
    if (!current) throw new NotFoundError(`SKU '${id}' not found`);

    const allowed = ALLOWED_SKU_TRANSITIONS[current.status];
    if (!allowed.includes(newStatus)) {
      throw new InvalidStateTransitionError(
        `Invalid SKU status transition from '${current.status}' to '${newStatus}'`,
      );
    }

    // SKU cannot be activated if parent product is ARCHIVED
    if (newStatus === 'ACTIVE') {
      const product = await this.repo.findProductById(current.product_id);
      if (!product || product.status === 'ARCHIVED') {
        throw new InvalidStateTransitionError('Cannot activate SKU for an ARCHIVED or missing product');
      }
    }

    const updated = await this.repo.updateSku(id, { status: newStatus });
    if (!updated) throw new NotFoundError(`SKU '${id}' not found`);

    return this.toSkuDto(updated);
  }

  // --- DTO mappers ---

  private toCategoryDto(row: CategoryRow): CategoryDto {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      parentId: row.parent_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toProductDto(row: ProductRow): ProductDto {
    return {
      id: row.id,
      title: row.title,
      slug: row.slug,
      description: row.description,
      brand: row.brand,
      categoryId: row.category_id,
      status: row.status,
      thumbnailUrl: row.thumbnail_url ?? null,
      images: parseStringArray(row.images),
      rating: row.rating != null ? Number(row.rating) : null,
      reviewCount: row.review_count != null ? Number(row.review_count) : 0,
      attributes: parseAttributes(row.attributes),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toReviewDto(row: ProductReviewRow): ProductReviewDto {
    return {
      id: row.id,
      productId: row.product_id,
      rating: Number(row.rating),
      comment: row.comment ?? null,
      reviewerName: row.reviewer_name ?? null,
      reviewerEmail: row.reviewer_email ?? null,
      reviewedAt: row.reviewed_at ?? null,
      createdAt: row.created_at,
    };
  }

  private toSkuDto(row: ProductSkuRow): ProductSkuDto {
    return {
      id: row.id,
      productId: row.product_id,
      skuCode: row.sku_code,
      barcode: row.barcode,
      attributes: parseAttributes(row.attributes),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };
}

function parseAttributes(val: unknown): Record<string, unknown> {
  if (typeof val === 'string') {
    try {
      const parsed: unknown = JSON.parse(val);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return {};
}

function parseStringArray(val: unknown): string[] {
  if (typeof val === 'string') {
    try {
      const parsed: unknown = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
      return [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(val)) return val.filter((v): v is string => typeof v === 'string');
  return [];
}
