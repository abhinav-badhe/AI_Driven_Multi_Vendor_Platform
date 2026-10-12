import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import { RbacPolicy } from '../../identity/rbac/policy.js';
import type {
  IMarketplaceService,
  MerchantListingDto,
  MerchantListingDetailDto,
  CreateListingInput,
  UpdateListingInput,
  ListingStatus,
  ListListingsFilter,
} from './marketplace-models.js';
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';

const ALLOWED_LISTING_TRANSITIONS: Record<ListingStatus, ListingStatus[]> = {
  DRAFT: ['ACTIVE', 'INACTIVE'],
  ACTIVE: ['INACTIVE', 'SUSPENDED'],
  INACTIVE: ['ACTIVE', 'SUSPENDED'],
  SUSPENDED: ['ACTIVE', 'INACTIVE'],
};

export class InMemoryMarketplaceStore implements IMarketplaceService {
  private readonly listings = new Map<string, MerchantListingDto>();

  async createListing(
    actor: AuthorizedActor,
    input: CreateListingInput,
  ): Promise<MerchantListingDto> {
    RbacPolicy.requirePermission(actor, 'listing:create');

    const skuId = input.skuId?.trim();
    if (!skuId) throw new ValidationError('skuId is required');

    if (
      typeof input.priceAmount !== 'number' ||
      !Number.isInteger(input.priceAmount) ||
      input.priceAmount < 0
    ) {
      throw new ValidationError(
        'priceAmount must be a non-negative integer (representing minor currency units)',
      );
    }

    const currency = input.currency?.toUpperCase().trim();
    if (!currency || currency.length !== 3) {
      throw new ValidationError('currency must be a valid 3-letter ISO code');
    }

    if (input.compareAtPrice !== undefined && input.compareAtPrice !== null) {
      if (
        typeof input.compareAtPrice !== 'number' ||
        !Number.isInteger(input.compareAtPrice) ||
        input.compareAtPrice < 0
      ) {
        throw new ValidationError('compareAtPrice must be a non-negative integer');
      }
    }

    for (const item of this.listings.values()) {
      if (item.tenantId === actor.tenantId && item.skuId === skuId) {
        throw new ConflictError(
          `Merchant already has a listing for SKU '${skuId}'. A merchant cannot duplicate listings for the same SKU.`,
        );
      }
    }

    const listing: MerchantListingDto = {
      id: `lst-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      tenantId: actor.tenantId,
      skuId,
      priceAmount: input.priceAmount,
      currency,
      compareAtPrice: input.compareAtPrice ?? null,
      status: 'DRAFT',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.listings.set(listing.id, listing);
    return listing;
  }

  async getMyListings(
    actor: AuthorizedActor,
    filter?: ListListingsFilter,
  ): Promise<MerchantListingDto[]> {
    RbacPolicy.requirePermission(actor, 'listing:read-own');
    let items = Array.from(this.listings.values()).filter((l) => l.tenantId === actor.tenantId);

    if (filter?.status) {
      items = items.filter((l) => l.status === filter.status);
    }
    if (filter?.skuId) {
      items = items.filter((l) => l.skuId === filter.skuId);
    }

    return items;
  }

  async getMyListingDetails(actor: AuthorizedActor): Promise<MerchantListingDetailDto[]> {
    RbacPolicy.requirePermission(actor, 'listing:read-own');
    const items = await this.getMyListings(actor);

    return items.map((l) => ({
      ...l,
      skuCode: `SKU-${l.skuId.slice(0, 6).toUpperCase()}`,
      productId: `prod-${l.skuId}`,
      productTitle: `Product for ${l.skuId}`,
      productSlug: `product-${l.skuId}`,
      brand: null,
      thumbnailUrl: null,
      images: [],
      rating: null,
      reviewCount: 0,
      onHandQuantity: 100,
      reservedQuantity: 0,
      availableQuantity: 100,
      inventoryVersion: 1,
    }));
  }

  async getListingById(actor: AuthorizedActor | null, id: string): Promise<MerchantListingDto> {
    const listing = this.listings.get(id);
    if (!listing) throw new NotFoundError(`Listing '${id}' not found`);

    if (actor) {
      if (actor.role === 'ADMINISTRATOR') {
        return listing;
      }
      if (actor.tenantId === listing.tenantId) {
        return listing;
      }
      if (listing.status === 'ACTIVE') {
        return listing;
      }
      throw new ForbiddenError(
        `Tenant isolation violation: actor tenant '${actor.tenantId}' cannot view inactive listing belonging to tenant '${listing.tenantId}'`,
      );
    }

    if (listing.status === 'ACTIVE') {
      return listing;
    }
    throw new NotFoundError(`Listing '${id}' not found`);
  }

  async updateListing(
    actor: AuthorizedActor,
    id: string,
    updates: UpdateListingInput,
  ): Promise<MerchantListingDto> {
    RbacPolicy.requirePermission(actor, 'listing:update-own');

    const current = this.listings.get(id);
    if (!current) throw new NotFoundError(`Listing '${id}' not found`);

    RbacPolicy.requireTenantMatch(actor, current.tenantId);

    if (current.status === 'SUSPENDED') {
      throw new ForbiddenError('Cannot update a SUSPENDED listing. Contact administrator.');
    }

    if (updates.priceAmount !== undefined) {
      if (
        typeof updates.priceAmount !== 'number' ||
        !Number.isInteger(updates.priceAmount) ||
        updates.priceAmount < 0
      ) {
        throw new ValidationError('priceAmount must be a non-negative integer');
      }
    }

    if (updates.currency !== undefined) {
      const cur = updates.currency.toUpperCase().trim();
      if (!cur || cur.length !== 3) {
        throw new ValidationError('currency must be a valid 3-letter ISO code');
      }
      updates.currency = cur;
    }

    if (updates.compareAtPrice !== undefined && updates.compareAtPrice !== null) {
      if (
        typeof updates.compareAtPrice !== 'number' ||
        !Number.isInteger(updates.compareAtPrice) ||
        updates.compareAtPrice < 0
      ) {
        throw new ValidationError('compareAtPrice must be a non-negative integer');
      }
    }

    const updated: MerchantListingDto = {
      ...current,
      ...(updates.priceAmount !== undefined && { priceAmount: updates.priceAmount }),
      ...(updates.currency !== undefined && { currency: updates.currency }),
      ...(updates.compareAtPrice !== undefined && {
        compareAtPrice: updates.compareAtPrice ?? null,
      }),
      updatedAt: new Date().toISOString(),
    };

    this.listings.set(id, updated);
    return updated;
  }

  async setListingStatus(
    actor: AuthorizedActor,
    id: string,
    newStatus: ListingStatus,
  ): Promise<MerchantListingDto> {
    const current = this.listings.get(id);
    if (!current) throw new NotFoundError(`Listing '${id}' not found`);

    const isAdmin = actor.role === 'ADMINISTRATOR';

    if (!isAdmin) {
      RbacPolicy.requirePermission(actor, 'listing:status-own');
      RbacPolicy.requireTenantMatch(actor, current.tenantId);

      if (current.status === 'SUSPENDED' || newStatus === 'SUSPENDED') {
        throw new ForbiddenError('Only platform administrators can manage SUSPENDED status');
      }
    } else {
      RbacPolicy.requirePermission(actor, 'listing:manage-any');
    }

    const allowed = ALLOWED_LISTING_TRANSITIONS[current.status];
    if (!allowed.includes(newStatus)) {
      throw new InvalidStateTransitionError(
        `Invalid listing status transition from '${current.status}' to '${newStatus}'`,
      );
    }

    const updated: MerchantListingDto = {
      ...current,
      status: newStatus,
      updatedAt: new Date().toISOString(),
    };

    this.listings.set(id, updated);
    return updated;
  }

  async getActiveListingsForSku(skuId: string): Promise<MerchantListingDto[]> {
    return Array.from(this.listings.values()).filter(
      (l) => l.skuId === skuId && l.status === 'ACTIVE',
    );
  }

  async listAllListings(
    actor: AuthorizedActor,
    filter?: ListListingsFilter,
  ): Promise<MerchantListingDto[]> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'listing:read-any');
    }
    let all = Array.from(this.listings.values());
    if (filter?.status && filter.status !== ('all' as any)) {
      all = all.filter((l) => l.status === filter.status);
    }
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 50;
    return all
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(offset, offset + limit);
  }
}
