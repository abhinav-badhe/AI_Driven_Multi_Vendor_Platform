import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type { ListingStatus, ListListingsFilter } from './listing-repository.js';
import type {
  MerchantListingDto,
  CreateListingInput,
  UpdateListingInput,
  MerchantListingDetailDto,
} from './listing-service.js';

export type {
  ListingStatus,
  ListListingsFilter,
  MerchantListingDto,
  CreateListingInput,
  UpdateListingInput,
  MerchantListingDetailDto,
};

/**
 * IMarketplaceReader - Decoupled read interface for marketplace listings.
 * Consumed by Cart/Checkout, Search, Recommendations, and Inventory domains.
 */
export interface IMarketplaceReader {
  getListingById(actor: AuthorizedActor | null, id: string): Promise<MerchantListingDto>;
  getActiveListingsForSku(skuId: string): Promise<MerchantListingDto[]>;
}

/**
 * IMarketplaceService (or IListingService) - Full marketplace listing lifecycle interface.
 * Implemented by local SQL ListingService, InMemoryMarketplaceStore, and HttpMarketplaceClient.
 */
export interface IMarketplaceService extends IMarketplaceReader {
  createListing(actor: AuthorizedActor, input: CreateListingInput): Promise<MerchantListingDto>;
  getMyListings(actor: AuthorizedActor, filter?: ListListingsFilter): Promise<MerchantListingDto[]>;
  getMyListingDetails(actor: AuthorizedActor): Promise<MerchantListingDetailDto[]>;
  updateListing(
    actor: AuthorizedActor,
    id: string,
    updates: UpdateListingInput,
  ): Promise<MerchantListingDto>;
  setListingStatus(
    actor: AuthorizedActor,
    id: string,
    newStatus: ListingStatus,
  ): Promise<MerchantListingDto>;
  listAllListings(
    actor: AuthorizedActor,
    filter?: ListListingsFilter,
  ): Promise<MerchantListingDto[]>;
}

export type IListingService = IMarketplaceService;
