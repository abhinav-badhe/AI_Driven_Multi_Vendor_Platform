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

export { ReviewService } from './internal/review-service.js';
export { ReviewRepository } from './internal/review-repository.js';
export type {
  ReviewStatus,
  ProductReviewRow,
  CreateReviewInput,
  UpdateReviewInput,
  ProductRatingSummary,
  ReviewEligibilityDto,
  ListReviewsFilter,
} from './internal/review-models.js';

import { ReviewService } from './internal/review-service.js';

export function createReviewService(
  db: DatabaseConnection,
  logger: Logger,
  outboxService?: import('../events/index.js').OutboxService,
): ReviewService {
  return new ReviewService(db, logger, outboxService);
}
