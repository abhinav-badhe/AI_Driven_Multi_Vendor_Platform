/**
 * BOUNDED CONTEXT: Search
 * Ownership: Derived read-only query models, search indexes, faceted search projections.
 *
 * Invariant: Search is a derived system.
 * It MUST NOT act as a transactional source of truth and MUST NOT directly write
 * to transactional domain tables.
 */

import type { Logger } from '../../observability/logger.js';
import type { CatalogService } from '../catalog/index.js';
import type { ListingService } from '../marketplace/index.js';
import type { InventoryService } from '../inventory/index.js';
import type { MerchantService } from '../merchant/index.js';
import { SearchService } from './internal/search-service.js';
import { InMemorySearchStore, type ISearchStore, type SearchStoreQueryResult, filterAndRankDocuments } from './internal/search-store.js';
import type {
  SearchProductDocument,
  SearchSellerOffer,
  SearchQueryParams,
  SearchResponseDto,
  SearchProductResultDto,
  SearchFacets,
  UpsertProductProjectionInput,
  UpsertListingProjectionInput,
  RebuildProjectionResult,
  SearchSortBy,
} from './internal/search-models.js';

export type {
  ISearchStore,
  SearchStoreQueryResult,
  SearchProductDocument,
  SearchSellerOffer,
  SearchQueryParams,
  SearchResponseDto,
  SearchProductResultDto,
  SearchFacets,
  UpsertProductProjectionInput,
  UpsertListingProjectionInput,
  RebuildProjectionResult,
  SearchSortBy,
};

export { filterAndRankDocuments };

export interface SearchModule {
  readonly contextName: 'search';
  createService(
    store: ISearchStore,
    logger: Logger,
    catalogService?: CatalogService,
    marketplaceService?: ListingService,
    inventoryService?: InventoryService,
    merchantService?: MerchantService,
  ): SearchService;
  createDefaultStore(): ISearchStore;
}

export const searchModule: SearchModule = {
  contextName: 'search',
  createService(
    store: ISearchStore,
    logger: Logger,
    catalogService?: CatalogService,
    marketplaceService?: ListingService,
    inventoryService?: InventoryService,
    merchantService?: MerchantService,
  ): SearchService {
    return new SearchService(
      store,
      logger,
      catalogService,
      marketplaceService,
      inventoryService,
      merchantService,
    );
  },
  createDefaultStore(): ISearchStore {
    return new InMemorySearchStore();
  },
};

export { SearchService, InMemorySearchStore };
export { SqlSearchStore } from '../../infra/search/sql-search-store.js';
