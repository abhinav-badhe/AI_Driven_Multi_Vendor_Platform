import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import { RbacPolicy } from '../../identity/rbac/policy.js';
import type {
  ICatalogService,
  CategoryDto,
  ProductDto,
  ProductReviewDto,
  ProductSkuDto,
  CreateCategoryInput,
  CreateProductInput,
  UpdateProductInput,
  CreateSkuInput,
  UpdateSkuInput,
  ProductStatus,
  SkuStatus,
  ListProductsFilter,
} from './catalog-models.js';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';

const ALLOWED_PRODUCT_TRANSITIONS: Record<ProductStatus, ProductStatus[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['INACTIVE', 'ARCHIVED'],
  INACTIVE: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [],
};

const ALLOWED_SKU_TRANSITIONS: Record<SkuStatus, SkuStatus[]> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['INACTIVE'],
  INACTIVE: ['ACTIVE'],
};

export class InMemoryCatalogStore implements ICatalogService {
  private readonly categories = new Map<string, CategoryDto>();
  private readonly products = new Map<string, ProductDto>();
  private readonly skus = new Map<string, ProductSkuDto>();
  private readonly reviews = new Map<string, ProductReviewDto[]>();

  // --- Category Operations ---

  async createCategory(actor: AuthorizedActor, input: CreateCategoryInput): Promise<CategoryDto> {
    RbacPolicy.requirePermission(actor, 'catalog:create');

    const name = input.name?.trim();
    if (!name) throw new ValidationError('Category name is required');

    const slug = input.slug?.toLowerCase().trim();
    if (!slug) throw new ValidationError('Category slug is required');

    if (input.parentId && !this.categories.has(input.parentId)) {
      throw new NotFoundError(`Parent category '${input.parentId}' not found`);
    }

    for (const cat of this.categories.values()) {
      if (cat.slug === slug) {
        throw new ConflictError(`Category with slug '${slug}' already exists`);
      }
    }

    const category: CategoryDto = {
      id: `cat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      slug,
      parentId: input.parentId ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.categories.set(category.id, category);
    return category;
  }

  async listCategories(): Promise<CategoryDto[]> {
    return Array.from(this.categories.values());
  }

  async getCategoryById(id: string): Promise<CategoryDto> {
    const cat = this.categories.get(id);
    if (!cat) throw new NotFoundError(`Category '${id}' not found`);
    return cat;
  }

  // --- Product Operations ---

  async createProduct(actor: AuthorizedActor, input: CreateProductInput): Promise<ProductDto> {
    RbacPolicy.requirePermission(actor, 'catalog:create');

    const title = input.title?.trim();
    if (!title) throw new ValidationError('Product title is required');

    const slug = input.slug?.toLowerCase().trim();
    if (!slug) throw new ValidationError('Product slug is required');

    if (input.categoryId && !this.categories.has(input.categoryId)) {
      throw new NotFoundError(`Category '${input.categoryId}' not found`);
    }

    for (const prod of this.products.values()) {
      if (prod.slug === slug) {
        throw new ConflictError(`Product with slug '${slug}' already exists`);
      }
    }

    const product: ProductDto = {
      id: `prod-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title,
      slug,
      description: input.description?.trim() ?? null,
      brand: input.brand?.trim() ?? null,
      categoryId: input.categoryId ?? null,
      status: 'DRAFT',
      thumbnailUrl: input.thumbnailUrl?.trim() || null,
      images: input.images ?? [],
      rating: null,
      reviewCount: 0,
      attributes: input.attributes ?? {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.products.set(product.id, product);
    return product;
  }

  async getProductById(id: string): Promise<ProductDto> {
    const prod = this.products.get(id);
    if (!prod) throw new NotFoundError(`Product '${id}' not found`);
    return prod;
  }

  async updateProduct(
    actor: AuthorizedActor,
    id: string,
    updates: UpdateProductInput,
  ): Promise<ProductDto> {
    RbacPolicy.requirePermission(actor, 'catalog:update');

    const current = this.products.get(id);
    if (!current) throw new NotFoundError(`Product '${id}' not found`);

    if (current.status === 'ARCHIVED') {
      throw new InvalidStateTransitionError('Cannot update an ARCHIVED product');
    }

    if (updates.categoryId && !this.categories.has(updates.categoryId)) {
      throw new NotFoundError(`Category '${updates.categoryId}' not found`);
    }

    if (updates.slug) {
      const slug = updates.slug.toLowerCase().trim();
      for (const prod of this.products.values()) {
        if (prod.slug === slug && prod.id !== id) {
          throw new ConflictError(`Product with slug '${slug}' already exists`);
        }
      }
    }

    const updated: ProductDto = {
      ...current,
      ...(updates.title !== undefined && { title: updates.title.trim() }),
      ...(updates.slug !== undefined && { slug: updates.slug.toLowerCase().trim() }),
      ...(updates.description !== undefined && { description: updates.description?.trim() ?? null }),
      ...(updates.brand !== undefined && { brand: updates.brand?.trim() ?? null }),
      ...(updates.categoryId !== undefined && { categoryId: updates.categoryId }),
      ...(updates.thumbnailUrl !== undefined && { thumbnailUrl: updates.thumbnailUrl?.trim() || null }),
      ...(updates.images !== undefined && { images: updates.images }),
      ...(updates.attributes !== undefined && { attributes: updates.attributes }),
      updatedAt: new Date().toISOString(),
    };

    this.products.set(id, updated);
    return updated;
  }

  async setProductStatus(
    actor: AuthorizedActor,
    id: string,
    newStatus: ProductStatus,
  ): Promise<ProductDto> {
    RbacPolicy.requirePermission(actor, 'catalog:status');

    const current = this.products.get(id);
    if (!current) throw new NotFoundError(`Product '${id}' not found`);

    const allowed = ALLOWED_PRODUCT_TRANSITIONS[current.status];
    if (!allowed.includes(newStatus)) {
      throw new InvalidStateTransitionError(
        `Invalid product status transition from '${current.status}' to '${newStatus}'`,
      );
    }

    const updated: ProductDto = {
      ...current,
      status: newStatus,
      updatedAt: new Date().toISOString(),
    };

    this.products.set(id, updated);
    return updated;
  }

  async listProducts(filter?: ListProductsFilter): Promise<ProductDto[]> {
    let list = Array.from(this.products.values());

    if (filter?.status) {
      list = list.filter((p) => p.status === filter.status);
    }
    if (filter?.categoryIds && filter.categoryIds.length > 0) {
      list = list.filter((p) => p.categoryId && filter.categoryIds!.includes(p.categoryId));
    } else if (filter?.categoryId) {
      const allCats = Array.from(this.categories.values());
      const targetId = filter.categoryId;
      const matched = new Set<string>([targetId]);
      const addDescendants = (parentId: string) => {
        for (const cat of allCats) {
          if (cat.parentId === parentId && !matched.has(cat.id)) {
            matched.add(cat.id);
            addDescendants(cat.id);
          }
        }
      };
      addDescendants(targetId);
      list = list.filter((p) => p.categoryId && matched.has(p.categoryId));
    }
    if (filter?.brand) {
      list = list.filter((p) => p.brand === filter.brand);
    }
    if (filter?.search) {
      const q = filter.search.toLowerCase();
      list = list.filter(
        (p) => p.title.toLowerCase().includes(q) || (p.description && p.description.toLowerCase().includes(q)),
      );
    }

    return list;
  }

  async listProductReviews(productId: string): Promise<ProductReviewDto[]> {
    if (!this.products.has(productId)) {
      throw new NotFoundError(`Product '${productId}' not found`);
    }
    return this.reviews.get(productId) ?? [];
  }

  // --- SKU Operations ---

  async createSku(
    actor: AuthorizedActor,
    productId: string,
    input: CreateSkuInput,
  ): Promise<ProductSkuDto> {
    RbacPolicy.requirePermission(actor, 'catalog:create');

    const product = this.products.get(productId);
    if (!product) throw new NotFoundError(`Product '${productId}' not found`);

    if (product.status === 'ARCHIVED') {
      throw new InvalidStateTransitionError('Cannot add SKU to an ARCHIVED product');
    }

    const skuCode = input.skuCode?.toUpperCase().trim();
    if (!skuCode) throw new ValidationError('SKU code is required');

    for (const s of this.skus.values()) {
      if (s.skuCode === skuCode) {
        throw new ConflictError(`SKU with code '${skuCode}' already exists`);
      }
    }

    const sku: ProductSkuDto = {
      id: `sku-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      productId,
      skuCode,
      barcode: input.barcode?.trim() ?? null,
      attributes: input.attributes ?? {},
      status: 'DRAFT',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.skus.set(sku.id, sku);
    return sku;
  }

  async getSkuById(id: string): Promise<ProductSkuDto> {
    const sku = this.skus.get(id);
    if (!sku) throw new NotFoundError(`SKU '${id}' not found`);
    return sku;
  }

  async listSkusByProduct(productId: string, actor?: AuthorizedActor | null): Promise<ProductSkuDto[]> {
    if (!this.products.has(productId)) {
      throw new NotFoundError(`Product '${productId}' not found`);
    }

    let list = Array.from(this.skus.values()).filter((s) => s.productId === productId);
    if (actor?.role !== 'ADMINISTRATOR') {
      list = list.filter((s) => s.status === 'ACTIVE');
    }
    return list;
  }

  async updateSku(
    actor: AuthorizedActor,
    id: string,
    updates: UpdateSkuInput,
  ): Promise<ProductSkuDto> {
    RbacPolicy.requirePermission(actor, 'catalog:update');

    const current = this.skus.get(id);
    if (!current) throw new NotFoundError(`SKU '${id}' not found`);

    const product = this.products.get(current.productId);
    if (product?.status === 'ARCHIVED') {
      throw new InvalidStateTransitionError('Cannot update SKU of an ARCHIVED product');
    }

    if (updates.skuCode) {
      const skuCode = updates.skuCode.toUpperCase().trim();
      for (const s of this.skus.values()) {
        if (s.skuCode === skuCode && s.id !== id) {
          throw new ConflictError(`SKU with code '${skuCode}' already exists`);
        }
      }
    }

    const updated: ProductSkuDto = {
      ...current,
      ...(updates.skuCode !== undefined && { skuCode: updates.skuCode.toUpperCase().trim() }),
      ...(updates.barcode !== undefined && { barcode: updates.barcode?.trim() ?? null }),
      ...(updates.attributes !== undefined && { attributes: updates.attributes }),
      updatedAt: new Date().toISOString(),
    };

    this.skus.set(id, updated);
    return updated;
  }

  async setSkuStatus(
    actor: AuthorizedActor,
    id: string,
    newStatus: SkuStatus,
  ): Promise<ProductSkuDto> {
    RbacPolicy.requirePermission(actor, 'catalog:status');

    const current = this.skus.get(id);
    if (!current) throw new NotFoundError(`SKU '${id}' not found`);

    const allowed = ALLOWED_SKU_TRANSITIONS[current.status];
    if (!allowed.includes(newStatus)) {
      throw new InvalidStateTransitionError(
        `Invalid SKU status transition from '${current.status}' to '${newStatus}'`,
      );
    }

    if (newStatus === 'ACTIVE') {
      const product = this.products.get(current.productId);
      if (!product || product.status === 'ARCHIVED') {
        throw new InvalidStateTransitionError('Cannot activate SKU for an ARCHIVED or missing product');
      }
    }

    const updated: ProductSkuDto = {
      ...current,
      status: newStatus,
      updatedAt: new Date().toISOString(),
    };

    this.skus.set(id, updated);
    return updated;
  }
}
