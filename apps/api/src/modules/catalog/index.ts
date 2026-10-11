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
  ProductStatus,
  SkuStatus,
  ListProductsFilter,
  ICatalogReader,
  ICatalogService,
} from './internal/catalog-models.js';
import { InMemoryCatalogStore } from './internal/in-memory-catalog-store.js';
import {
  HttpCatalogClient,
  type HttpCatalogClientOptions,
} from './internal/http-catalog-client.js';

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
  ICatalogReader,
  ICatalogService,
  HttpCatalogClientOptions,
};

export interface CatalogModule {
  readonly contextName: 'catalog';
  createService(db: DatabaseConnection, logger: Logger): CatalogService;
  createInMemoryStore(): InMemoryCatalogStore;
  createHttpClient(serviceUrl: string, options?: HttpCatalogClientOptions): HttpCatalogClient;
}

export const catalogModule: CatalogModule = {
  contextName: 'catalog',
  createService(db: DatabaseConnection, logger: Logger): CatalogService {
    return new CatalogService(db, logger);
  },
  createInMemoryStore(): InMemoryCatalogStore {
    return new InMemoryCatalogStore();
  },
  createHttpClient(serviceUrl: string, options?: HttpCatalogClientOptions): HttpCatalogClient {
    return new HttpCatalogClient(serviceUrl, options);
  },
};

export { CatalogService, InMemoryCatalogStore, HttpCatalogClient };

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
