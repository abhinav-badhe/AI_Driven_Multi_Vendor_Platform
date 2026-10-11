/**
 * BOUNDED CONTEXT: Search
 * Ownership: Derived read-only query models, search indexes, faceted search projections.
 *
 * Invariant: Search is a derived system.
 * It MUST NOT act as a transactional source of truth and MUST NOT directly write
 * to transactional domain tables.
 */

import type { Logger } from '../../observability/logger.js';
import type { CatalogService, ICatalogReader } from '../catalog/index.js';
import type { ListingService, IMarketplaceReader } from '../marketplace/index.js';
import type { InventoryService, IInventoryReader } from '../inventory/index.js';
import type { MerchantService, IMerchantProfileReader } from '../merchant/index.js';
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

import {
  HttpSearchStoreAdapter,
  type HttpSearchStoreOptions,
} from './internal/http-search-store.js';

export interface SearchModule {
  readonly contextName: 'search';
  createService(
    store: ISearchStore,
    logger: Logger,
    catalogService?: ICatalogReader | CatalogService,
    marketplaceService?: IMarketplaceReader | ListingService,
    inventoryService?: IInventoryReader | InventoryService,
    merchantService?: IMerchantProfileReader | MerchantService,
  ): SearchService;
  createDefaultStore(): ISearchStore;
  createHttpStore(serviceUrl: string, options?: HttpSearchStoreOptions): HttpSearchStoreAdapter;
}

export const searchModule: SearchModule = {
  contextName: 'search',
  createService(
    store: ISearchStore,
    logger: Logger,
    catalogService?: ICatalogReader | CatalogService,
    marketplaceService?: IMarketplaceReader | ListingService,
    inventoryService?: IInventoryReader | InventoryService,
    merchantService?: IMerchantProfileReader | MerchantService,
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
  createHttpStore(serviceUrl: string, options?: HttpSearchStoreOptions): HttpSearchStoreAdapter {
    return new HttpSearchStoreAdapter(serviceUrl, options);
  },
};

export { SearchService, InMemorySearchStore, HttpSearchStoreAdapter };
export type { HttpSearchStoreOptions };
export { SqlSearchStore } from '../../infra/search/sql-search-store.js';
