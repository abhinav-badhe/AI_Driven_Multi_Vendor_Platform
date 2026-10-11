import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { CatalogService, ICatalogReader } from '../catalog/index.js';
import type { MerchantService, IMerchantProfileReader } from '../merchant/index.js';
import { ListingService } from './internal/listing-service.js';
import { InMemoryMarketplaceStore } from './internal/in-memory-marketplace-store.js';
import {
  HttpMarketplaceClient,
  type HttpMarketplaceClientOptions,
} from './internal/http-marketplace-client.js';
import type {
  MerchantListingDto,
  MerchantListingDetailDto,
  CreateListingInput,
  UpdateListingInput,
  IMarketplaceReader,
  IMarketplaceService,
  IListingService,
} from './internal/marketplace-models.js';
import type { ListingStatus, ListListingsFilter } from './internal/listing-repository.js';

export type {
  MerchantListingDto,
  MerchantListingDetailDto,
  CreateListingInput,
  UpdateListingInput,
  ListingStatus,
  ListListingsFilter,
  IMarketplaceReader,
  IMarketplaceService,
  IListingService,
  HttpMarketplaceClientOptions,
};

import type { ISecurityAuditService } from '../identity/index.js';

export interface MarketplaceModule {
  readonly contextName: 'marketplace';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    catalogService: ICatalogReader | CatalogService,
    merchantService: IMerchantProfileReader | MerchantService,
    audit?: ISecurityAuditService,
  ): ListingService;
  createInMemoryStore(): InMemoryMarketplaceStore;
  createHttpClient(
    serviceUrl: string,
    options?: HttpMarketplaceClientOptions,
  ): HttpMarketplaceClient;
}

export const marketplaceModule: MarketplaceModule = {
  contextName: 'marketplace',
  createService(
    db: DatabaseConnection,
    logger: Logger,
    catalogService: ICatalogReader | CatalogService,
    merchantService: IMerchantProfileReader | MerchantService,
    audit?: ISecurityAuditService,
  ): ListingService {
    return new ListingService(db, logger, catalogService, merchantService, audit);
  },
  createInMemoryStore(): InMemoryMarketplaceStore {
    return new InMemoryMarketplaceStore();
  },
  createHttpClient(
    serviceUrl: string,
    options?: HttpMarketplaceClientOptions,
  ): HttpMarketplaceClient {
    return new HttpMarketplaceClient(serviceUrl, options);
  },
};

export { ListingService, InMemoryMarketplaceStore, HttpMarketplaceClient };
