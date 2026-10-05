import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { CatalogService } from '../catalog/index.js';
import type { MerchantService } from '../merchant/index.js';
import { ListingService } from './internal/listing-service.js';
import type {
  MerchantListingDto,
  MerchantListingDetailDto,
  CreateListingInput,
  UpdateListingInput,
} from './internal/listing-service.js';
import type { ListingStatus, ListListingsFilter } from './internal/listing-repository.js';

export type {
  MerchantListingDto,
  MerchantListingDetailDto,
  CreateListingInput,
  UpdateListingInput,
  ListingStatus,
  ListListingsFilter,
};

export interface MarketplaceModule {
  readonly contextName: 'marketplace';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    catalogService: CatalogService,
    merchantService: MerchantService,
  ): ListingService;
}

export const marketplaceModule: MarketplaceModule = {
  contextName: 'marketplace',
  createService(
    db: DatabaseConnection,
    logger: Logger,
    catalogService: CatalogService,
    merchantService: MerchantService,
  ): ListingService {
    return new ListingService(db, logger, catalogService, merchantService);
  },
};

export { ListingService };
