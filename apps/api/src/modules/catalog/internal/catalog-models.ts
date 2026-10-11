import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type {
  ProductStatus,
  SkuStatus,
  ListProductsFilter,
} from './catalog-repository.js';
import type {
  CategoryDto,
  ProductDto,
  ProductReviewDto,
  ProductSkuDto,
  CreateCategoryInput,
  CreateProductInput,
  UpdateProductInput,
  CreateSkuInput,
  UpdateSkuInput,
} from './catalog-service.js';

export type {
  ProductStatus,
  SkuStatus,
  ListProductsFilter,
  CategoryDto,
  ProductDto,
  ProductReviewDto,
  ProductSkuDto,
  CreateCategoryInput,
  CreateProductInput,
  UpdateProductInput,
  CreateSkuInput,
  UpdateSkuInput,
};

/**
 * ICatalogReader - Read-only catalog query interface.
 * Consumed by Marketplace, Search, Recommendations, Cart/Checkout, and AI modules.
 */
export interface ICatalogReader {
  listCategories(): Promise<CategoryDto[]>;
  getCategoryById(id: string): Promise<CategoryDto>;
  getProductById(id: string): Promise<ProductDto>;
  listProducts(filter?: ListProductsFilter): Promise<ProductDto[]>;
  getSkuById(id: string): Promise<ProductSkuDto>;
  listSkusByProduct(productId: string, actor?: AuthorizedActor | null): Promise<ProductSkuDto[]>;
  listProductReviews(productId: string): Promise<ProductReviewDto[]>;
}

/**
 * ICatalogService - Complete Catalog Domain management interface.
 * Implemented by local SQL CatalogService, InMemoryCatalogStore, and HttpCatalogClient.
 */
export interface ICatalogService extends ICatalogReader {
  createCategory(actor: AuthorizedActor, input: CreateCategoryInput): Promise<CategoryDto>;
  createProduct(actor: AuthorizedActor, input: CreateProductInput): Promise<ProductDto>;
  updateProduct(
    actor: AuthorizedActor,
    id: string,
    updates: UpdateProductInput,
  ): Promise<ProductDto>;
  setProductStatus(
    actor: AuthorizedActor,
    id: string,
    newStatus: ProductStatus,
  ): Promise<ProductDto>;
  createSku(
    actor: AuthorizedActor,
    productId: string,
    input: CreateSkuInput,
  ): Promise<ProductSkuDto>;
  updateSku(
    actor: AuthorizedActor,
    id: string,
    updates: UpdateSkuInput,
  ): Promise<ProductSkuDto>;
  setSkuStatus(
    actor: AuthorizedActor,
    id: string,
    newStatus: SkuStatus,
  ): Promise<ProductSkuDto>;
}
