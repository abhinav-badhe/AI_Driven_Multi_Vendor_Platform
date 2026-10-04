import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { AuthorizedActor } from '../../identity/index.js';
import { RbacPolicy, SecurityAuditService } from '../../identity/index.js';
import type { CatalogService } from '../../catalog/index.js';
import type { MerchantService } from '../../merchant/index.js';
import {
  ListingRepository,
  type ListingStatus,
  type MerchantListingRow,
  type ListListingsFilter,
} from './listing-repository.js';
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';

// Domain-enforced listing lifecycle transitions
const ALLOWED_LISTING_TRANSITIONS: Record<ListingStatus, ListingStatus[]> = {
  DRAFT: ['ACTIVE', 'INACTIVE'],
  ACTIVE: ['INACTIVE', 'SUSPENDED'],
  INACTIVE: ['ACTIVE', 'SUSPENDED'],
  SUSPENDED: ['ACTIVE', 'INACTIVE'],
};

export interface MerchantListingDto {
  id: string;
  tenantId: string;
  skuId: string;
  priceAmount: number;
  currency: string;
  compareAtPrice?: number | null;
  status: ListingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateListingInput {
  skuId: string;
  priceAmount: number;
  currency: string;
  compareAtPrice?: number | null | undefined;
}

export interface UpdateListingInput {
  priceAmount?: number | undefined;
  currency?: string | undefined;
  compareAtPrice?: number | null | undefined;
}

export class ListingService {
  private readonly repo: ListingRepository;
  private readonly audit: SecurityAuditService;
  private readonly catalogService: CatalogService;
  private readonly merchantService: MerchantService;

  constructor(
    db: DatabaseConnection,
    logger: Logger,
    catalogService: CatalogService,
    merchantService: MerchantService,
  ) {
    this.repo = new ListingRepository(db);
    this.audit = new SecurityAuditService(db, logger);
    this.catalogService = catalogService;
    this.merchantService = merchantService;
  }

  async createListing(
    actor: AuthorizedActor,
    input: CreateListingInput,
  ): Promise<MerchantListingDto> {
    RbacPolicy.requirePermission(actor, 'listing:create');

    const skuId = input.skuId?.trim();
    if (!skuId) throw new ValidationError('skuId is required');

    if (typeof input.priceAmount !== 'number' || !Number.isInteger(input.priceAmount) || input.priceAmount < 0) {
      throw new ValidationError('priceAmount must be a non-negative integer (representing minor currency units)');
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

    // Verify canonical SKU exists in catalog
    await this.catalogService.getSkuById(skuId);

    // Enforce uniqueness: a merchant cannot create multiple listings for the same SKU
    const existing = await this.repo.findListingByMerchantAndSku(actor.tenantId, skuId);
    if (existing) {
      throw new ConflictError(
        `Merchant already has a listing for SKU '${skuId}'. A merchant cannot duplicate listings for the same SKU.`,
      );
    }

    // New listings begin in DRAFT status
    const row = await this.repo.createListing({
      tenantId: actor.tenantId,
      skuId,
      priceAmount: input.priceAmount,
      currency,
      compareAtPrice: input.compareAtPrice,
      status: 'DRAFT',
    });

    return this.toDto(row);
  }

  async getMyListings(
    actor: AuthorizedActor,
    filter?: ListListingsFilter,
  ): Promise<MerchantListingDto[]> {
    RbacPolicy.requirePermission(actor, 'listing:read-own');
    const rows = await this.repo.listListingsByTenant(actor.tenantId, filter);
    return rows.map((r) => this.toDto(r));
  }

  async getListingById(
    actor: AuthorizedActor | null,
    id: string,
  ): Promise<MerchantListingDto> {
    const listing = await this.repo.findListingById(id);
    if (!listing) throw new NotFoundError(`Listing '${id}' not found`);

    if (actor) {
      if (actor.role === 'ADMINISTRATOR') {
        return this.toDto(listing);
      }
      if (actor.tenantId === listing.tenant_id) {
        return this.toDto(listing);
      }
      if (listing.status === 'ACTIVE') {
        return this.toDto(listing);
      }
      throw new ForbiddenError(
        `Tenant isolation violation: actor tenant '${actor.tenantId}' cannot view inactive listing belonging to tenant '${listing.tenant_id}'`,
      );
    }

    // Unauthenticated public request
    if (listing.status === 'ACTIVE') {
      return this.toDto(listing);
    }
    throw new NotFoundError(`Listing '${id}' not found`);
  }

  async updateListing(
    actor: AuthorizedActor,
    id: string,
    updates: UpdateListingInput,
  ): Promise<MerchantListingDto> {
    RbacPolicy.requirePermission(actor, 'listing:update-own');

    const current = await this.repo.findListingById(id);
    if (!current) throw new NotFoundError(`Listing '${id}' not found`);

    // Strict tenant isolation: a merchant cannot modify another merchant's listing
    RbacPolicy.requireTenantMatch(actor, current.tenant_id);

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

    const updated = await this.repo.updateListing(id, updates);
    if (!updated) throw new NotFoundError(`Listing '${id}' not found`);

    return this.toDto(updated);
  }

  async setListingStatus(
    actor: AuthorizedActor,
    id: string,
    newStatus: ListingStatus,
  ): Promise<MerchantListingDto> {
    const current = await this.repo.findListingById(id);
    if (!current) throw new NotFoundError(`Listing '${id}' not found`);

    const isAdmin = actor.role === 'ADMINISTRATOR';

    if (!isAdmin) {
      // Non-admin can only operate on their own tenant's listings
      RbacPolicy.requirePermission(actor, 'listing:status-own');
      RbacPolicy.requireTenantMatch(actor, current.tenant_id);

      // Merchants cannot suspend listings or unsuspend suspended listings
      if (current.status === 'SUSPENDED' || newStatus === 'SUSPENDED') {
        throw new ForbiddenError('Only platform administrators can manage SUSPENDED status');
      }
    } else {
      RbacPolicy.requirePermission(actor, 'listing:manage-any');
    }

    // Verify valid state transition
    const allowed = ALLOWED_LISTING_TRANSITIONS[current.status];
    if (!allowed.includes(newStatus)) {
      throw new InvalidStateTransitionError(
        `Invalid listing status transition from '${current.status}' to '${newStatus}'`,
      );
    }

    // When transitioning to ACTIVE:
    // 1. SKU must be ACTIVE in Catalog
    // 2. Merchant must be VERIFIED in Merchant module
    if (newStatus === 'ACTIVE') {
      const sku = await this.catalogService.getSkuById(current.sku_id);
      if (sku.status !== 'ACTIVE') {
        throw new InvalidStateTransitionError(
          `Cannot activate listing: Canonical SKU '${current.sku_id}' is '${sku.status}' (must be ACTIVE)`,
        );
      }

      const merchant = await this.merchantService.getProfileByTenantId(current.tenant_id);
      if (!merchant || merchant.verificationStatus !== 'VERIFIED') {
        throw new InvalidStateTransitionError(
          `Cannot activate listing: Merchant tenant '${current.tenant_id}' is not VERIFIED (status: ${merchant?.verificationStatus ?? 'NOT_ONBOARDED'})`,
        );
      }
    }

    const updated = await this.repo.updateListing(id, { status: newStatus });
    if (!updated) throw new NotFoundError(`Listing '${id}' not found`);

    if (newStatus === 'SUSPENDED') {
      await this.audit.record({
        eventType: 'LISTING_SUSPENDED',
        actorId: actor.userId,
        tenantId: current.tenant_id,
        metadata: { listingId: id, reason: 'Administrative suspension' },
      });
    }

    return this.toDto(updated);
  }

  async getActiveListingsForSku(skuId: string): Promise<MerchantListingDto[]> {
    // Multi-vendor marketplace listing comparison
    // First verify SKU exists
    await this.catalogService.getSkuById(skuId);

    const rows = await this.repo.listActiveListingsBySku(skuId);
    return rows.map((r) => this.toDto(r));
  }

  private toDto(row: MerchantListingRow): MerchantListingDto {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      skuId: row.sku_id,
      priceAmount: Number(row.price_amount),
      currency: row.currency,
      compareAtPrice: row.compare_at_price !== null ? Number(row.compare_at_price) : null,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
