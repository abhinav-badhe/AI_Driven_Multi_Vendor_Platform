import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import { CatalogService } from './internal/catalog-service.js';
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
} from './internal/catalog-service.js';
import type { ProductStatus, SkuStatus, ListProductsFilter } from './internal/catalog-repository.js';

export type {
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
};

export interface CatalogModule {
  readonly contextName: 'catalog';
  createService(db: DatabaseConnection, logger: Logger): CatalogService;
}

export const catalogModule: CatalogModule = {
  contextName: 'catalog',
  createService(db: DatabaseConnection, logger: Logger): CatalogService {
    return new CatalogService(db, logger);
  },
};

export { CatalogService };
