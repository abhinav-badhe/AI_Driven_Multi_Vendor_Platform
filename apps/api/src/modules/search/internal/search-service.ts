import type { Logger } from '../../../observability/logger.js';
import type { AuthorizedActor } from '../../identity/index.js';
import { RbacPolicy } from '../../identity/index.js';
import type { CatalogService } from '../../catalog/index.js';
import type { ListingService } from '../../marketplace/index.js';
import type { InventoryService } from '../../inventory/index.js';
import type { MerchantService } from '../../merchant/index.js';
import {
  ValidationError,
  ForbiddenError,
  NotFoundError,
} from '../../../errors/app-error.js';
import type { ISearchStore } from './search-store.js';
import type {
  SearchProductDocument,
  SearchSellerOffer,
  SearchQueryParams,
  SearchResponseDto,
  SearchProductResultDto,
  UpsertProductProjectionInput,
  UpsertListingProjectionInput,
  RebuildProjectionResult,
} from './search-models.js';

/**
 * Search Service - Governed Read-Model Query & Projection Service.
 *
 * CRITICAL ARCHITECTURAL CONSTRAINTS:
 * 1. Search is a read-optimized, derived projection.
 * 2. Search NEVER performs transactional mutations on core domain tables.
 * 3. Search documents are eventually consistent snapshots.
 * 4. Stale projection writes (older source version) are rejected deterministically.
 */
export class SearchService {
  private readonly productLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: ISearchStore,
    private readonly logger: Logger,
    private readonly catalogService?: CatalogService,
    private readonly marketplaceService?: ListingService,
    private readonly inventoryService?: InventoryService,
    private readonly merchantService?: MerchantService,
  ) {}

  // --- Search Store Accessor (for health checks / metrics) ---
  getStore(): ISearchStore {
    return this.store;
  }

  /**
   * Local in-process concurrency optimization.
   *
   * ARCHITECTURAL NOTE: This in-process mutex is strictly a local execution optimization
   * to serialize concurrent async operations against the same product within a single process.
   * It is NOT a distributed lock and does NOT guarantee distributed correctness across a cluster.
   *
   * True distributed correctness in the Search bounded context depends entirely on:
   * 1. Deterministic sourceVersion comparison against the stored document's sourceVersion.
   * 2. Stale-write rejection (dropping any write where incoming sourceVersion <= existing sourceVersion).
   * 3. Idempotent projection document upserts.
   */
  private async withProductLock<T>(productId: string, action: () => Promise<T>): Promise<T> {
    while (this.productLocks.has(productId)) {
      await this.productLocks.get(productId);
    }
    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((res) => {
      resolveLock = res;
    });
    this.productLocks.set(productId, lockPromise);

    try {
      return await action();
    } finally {
      this.productLocks.delete(productId);
      resolveLock();
    }
  }

  // --- Public Search Query API ---

  async search(
    actor: AuthorizedActor | null,
    params: SearchQueryParams,
  ): Promise<SearchResponseDto> {
    // 1. Validate & Normalize Pagination
    const page = params.page !== undefined ? Number(params.page) : 1;
    const pageSize = params.pageSize !== undefined ? Number(params.pageSize) : 20;

    if (!Number.isInteger(page) || page < 1) {
      throw new ValidationError('page must be a positive integer greater than or equal to 1');
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new ValidationError('pageSize must be an integer between 1 and 100');
    }

    // 2. Validate Price Range Parameters
    if (params.minPrice !== undefined) {
      if (typeof params.minPrice !== 'number' || params.minPrice < 0) {
        throw new ValidationError('minPrice must be a non-negative number');
      }
    }
    if (params.maxPrice !== undefined) {
      if (typeof params.maxPrice !== 'number' || params.maxPrice < 0) {
        throw new ValidationError('maxPrice must be a non-negative number');
      }
    }
    if (
      params.minPrice !== undefined &&
      params.maxPrice !== undefined &&
      params.minPrice > params.maxPrice
    ) {
      throw new ValidationError('minPrice cannot be greater than maxPrice');
    }

    // 3. Validate Sort Option
    const validSorts = ['relevance', 'price_asc', 'price_desc', 'newest'];
    if (params.sortBy && !validSorts.includes(params.sortBy)) {
      throw new ValidationError(
        `Invalid sortBy '${params.sortBy}'. Allowed values: ${validSorts.join(', ')}`,
      );
    }

    // 4. Sanitize Query (Defend against raw search-engine DSL injection)
    let sanitizedQ = params.q?.trim();
    if (sanitizedQ) {
      // Strip control / DSL syntax characters: {}[]()*+?~\"\\/^
      sanitizedQ = sanitizedQ.replace(/[{}[\]()*+?~"\\/^]/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // 5. Enforce Visibility & Tenant Isolation
    let includeInactive = false;
    if (params.includeInactive === true) {
      if (actor && actor.role === 'ADMINISTRATOR') {
        includeInactive = true;
      } else {
        throw new ForbiddenError('Only platform administrators can inspect inactive search documents');
      }
    }

    const queryParams: SearchQueryParams = {
      ...params,
      q: sanitizedQ || undefined,
      page,
      pageSize,
      includeInactive,
    };

    const storeResult = await this.store.search(queryParams);

    // 6. Map Documents to Output DTOs with Multi-Vendor Offers Context
    const items: SearchProductResultDto[] = storeResult.items.map((doc) => {
      const visibleOffers = includeInactive
        ? doc.offers
        : doc.offers.filter((o) => o.status === 'ACTIVE');

      // Best offer is the active offer with the lowest price
      let bestOffer: SearchSellerOffer | null = null;
      if (visibleOffers.length > 0) {
        bestOffer = visibleOffers.reduce((best, curr) =>
          curr.priceAmount < best.priceAmount ? curr : best,
        );
      }

      // Matched offer if query targeted a specific merchant
      let matchedOffer: SearchSellerOffer | null = null;
      if (params.merchantId) {
        matchedOffer = visibleOffers.find((o) => o.merchantId === params.merchantId) ?? null;
      }

      return {
        productId: doc.id,
        title: doc.title,
        slug: doc.slug,
        description: doc.description,
        brand: doc.brand,
        categoryId: doc.categoryId,
        categoryName: doc.categoryName,
        minPrice: doc.minPrice,
        maxPrice: doc.maxPrice,
        currency: doc.currency,
        hasInStockOffer: doc.hasInStockOffer,
        totalOffersCount: visibleOffers.length,
        bestOffer,
        matchedOffer,
        offers: visibleOffers,
        attributes: doc.attributes,
        score: storeResult.scores.get(doc.id),
        projectionVersion: doc.projectionVersion,
        updatedAt: doc.updatedAt,
      };
    });

    const totalPages = Math.ceil(storeResult.total / pageSize);

    return {
      items,
      total: storeResult.total,
      page,
      pageSize,
      totalPages,
      query: sanitizedQ || undefined,
      facets: storeResult.facets,
    };
  }

  async getDocumentById(
    actor: AuthorizedActor | null,
    productId: string,
  ): Promise<SearchProductResultDto> {
    const doc = await this.store.getDocument(productId);
    if (!doc) {
      throw new NotFoundError(`Product document '${productId}' not found in search index`);
    }

    const isAdmin = actor?.role === 'ADMINISTRATOR';
    if (!isAdmin && doc.status !== 'ACTIVE') {
      throw new NotFoundError(`Product document '${productId}' not found in search index`);
    }

    const visibleOffers = isAdmin
      ? doc.offers
      : doc.offers.filter((o) => o.status === 'ACTIVE');

    let bestOffer: SearchSellerOffer | null = null;
    if (visibleOffers.length > 0) {
      bestOffer = visibleOffers.reduce((best, curr) =>
        curr.priceAmount < best.priceAmount ? curr : best,
      );
    }

    return {
      productId: doc.id,
      title: doc.title,
      slug: doc.slug,
      description: doc.description,
      brand: doc.brand,
      categoryId: doc.categoryId,
      categoryName: doc.categoryName,
      minPrice: doc.minPrice,
      maxPrice: doc.maxPrice,
      currency: doc.currency,
      hasInStockOffer: doc.hasInStockOffer,
      totalOffersCount: visibleOffers.length,
      bestOffer,
      offers: visibleOffers,
      attributes: doc.attributes,
      projectionVersion: doc.projectionVersion,
      updatedAt: doc.updatedAt,
    };
  }

  // --- Projection Synchronization API (Stale-Write Protected) ---

  async upsertProductProjection(
    input: UpsertProductProjectionInput,
  ): Promise<{ indexed: boolean; reason?: string }> {
    return this.withProductLock(input.productId, async () => {
      const existing = await this.store.getDocument(input.productId);

      if (existing) {
        // Deterministic Stale Write Protection:
        // If an older or identical source version arrives after a newer version, ignore it!
        if (input.sourceVersion <= existing.sourceVersion) {
          this.logger.warn('Stale or duplicate product projection update ignored', {
            productId: input.productId,
            incomingVersion: input.sourceVersion,
            existingVersion: existing.sourceVersion,
          });
          return { indexed: false, reason: 'STALE_OR_DUPLICATE_VERSION' };
        }

        const activeOffers = existing.offers.filter((o) => o.status === 'ACTIVE');
        const minPrice =
          activeOffers.length > 0
            ? Math.min(...activeOffers.map((o) => o.priceAmount))
            : existing.minPrice;
        const maxPrice =
          activeOffers.length > 0
            ? Math.max(...activeOffers.map((o) => o.priceAmount))
            : existing.maxPrice;
        const hasInStockOffer = activeOffers.some((o) => o.inStock && o.availableQuantity > 0);

        const updatedDoc: SearchProductDocument = {
          ...existing,
          title: input.title,
          slug: input.slug,
          description: input.description !== undefined ? input.description : existing.description,
          brand: input.brand !== undefined ? input.brand : existing.brand,
          categoryId:
            input.categoryId !== undefined ? input.categoryId : existing.categoryId,
          categoryName:
            input.categoryName !== undefined ? input.categoryName : existing.categoryName,
          status: input.status,
          attributes: { ...(existing.attributes ?? {}), ...(input.attributes ?? {}) },
          minPrice,
          maxPrice,
          hasInStockOffer,
          totalOffersCount: activeOffers.length,
          sourceVersion: input.sourceVersion,
          projectionVersion: existing.projectionVersion + 1,
          updatedAt: new Date().toISOString(),
        };

        await this.store.indexDocument(updatedDoc);
        return { indexed: true };
      }

      // Initial Product Indexing
      const now = new Date().toISOString();
      const newDoc: SearchProductDocument = {
        id: input.productId,
        title: input.title,
        slug: input.slug,
        description: input.description ?? null,
        brand: input.brand ?? null,
        categoryId: input.categoryId ?? null,
        categoryName: input.categoryName ?? null,
        status: input.status,
        minPrice: 0,
        maxPrice: 0,
        currency: 'INR',
        hasInStockOffer: false,
        totalOffersCount: 0,
        offers: [],
        attributes: input.attributes ?? {},
        sourceVersion: input.sourceVersion,
        projectionVersion: 1,
        createdAt: input.createdAt ?? now,
        updatedAt: now,
      };

      await this.store.indexDocument(newDoc);
      return { indexed: true };
    });
  }

  async upsertListingProjection(
    input: UpsertListingProjectionInput,
  ): Promise<{ indexed: boolean; reason?: string }> {
    return this.withProductLock(input.productId, async () => {
      let doc = await this.store.getDocument(input.productId);

      if (!doc) {
        // Create initial placeholder product document if listing arrives first
        const now = new Date().toISOString();
        doc = {
          id: input.productId,
          title: `Product ${input.productId}`,
          slug: `product-${input.productId}`,
          description: null,
          brand: null,
          categoryId: null,
          categoryName: null,
          status: 'ACTIVE',
          minPrice: input.priceAmount,
          maxPrice: input.priceAmount,
          currency: input.currency,
          hasInStockOffer: input.inStock && input.availableQuantity > 0,
          totalOffersCount: 0,
          offers: [],
          attributes: {},
          sourceVersion: input.sourceVersion,
          projectionVersion: 0,
          createdAt: now,
          updatedAt: now,
        };
      }

      // Check for stale listing update
      const existingOfferIndex = doc.offers.findIndex((o) => o.listingId === input.listingId);
      if (existingOfferIndex >= 0) {
        const existingOffer = doc.offers[existingOfferIndex]!;
        if (input.sourceVersion <= existingOffer.sourceVersion) {
          this.logger.warn('Stale or duplicate listing projection update ignored', {
            listingId: input.listingId,
            incomingVersion: input.sourceVersion,
            existingVersion: existingOffer.sourceVersion,
          });
          return { indexed: false, reason: 'STALE_OR_DUPLICATE_VERSION' };
        }
      }

      const updatedOffer: SearchSellerOffer = {
        listingId: input.listingId,
        merchantId: input.merchantId,
        merchantName: input.merchantName,
        skuId: input.skuId,
        skuCode: input.skuCode,
        priceAmount: input.priceAmount,
        currency: input.currency,
        compareAtPrice: input.compareAtPrice ?? null,
        status: input.status,
        inStock: input.inStock,
        availableQuantity: input.availableQuantity,
        attributes: input.attributes ?? {},
        sourceVersion: input.sourceVersion,
        updatedAt: new Date().toISOString(),
      };

      const updatedOffers = [...doc.offers];
      if (existingOfferIndex >= 0) {
        updatedOffers[existingOfferIndex] = updatedOffer;
      } else {
        updatedOffers.push(updatedOffer);
      }

      const activeOffers = updatedOffers.filter((o) => o.status === 'ACTIVE');
      const minPrice =
        activeOffers.length > 0 ? Math.min(...activeOffers.map((o) => o.priceAmount)) : 0;
      const maxPrice =
        activeOffers.length > 0 ? Math.max(...activeOffers.map((o) => o.priceAmount)) : 0;
      const hasInStockOffer = activeOffers.some((o) => o.inStock && o.availableQuantity > 0);

      const updatedDoc: SearchProductDocument = {
        ...doc,
        minPrice,
        maxPrice,
        currency: input.currency,
        hasInStockOffer,
        totalOffersCount: activeOffers.length,
        offers: updatedOffers,
        sourceVersion: Math.max(doc.sourceVersion, input.sourceVersion),
        projectionVersion: doc.projectionVersion + 1,
        updatedAt: new Date().toISOString(),
      };

      await this.store.indexDocument(updatedDoc);
      return { indexed: true };
    });
  }

  async updateOfferAvailability(input: {
    listingId: string;
    inStock: boolean;
    availableQuantity: number;
    sourceVersion: number;
  }): Promise<{ updated: boolean; reason?: string }> {
    // 1. Locate product containing this listing offer
    let productId: string | null = null;
    if (this.store.findProductIdByListingId) {
      productId = await this.store.findProductIdByListingId(input.listingId);
    }

    if (!productId && this.marketplaceService && this.catalogService) {
      try {
        const listing = await this.marketplaceService.getListingById(null, input.listingId);
        const sku = await this.catalogService.getSkuById(listing.skuId);
        productId = sku.productId;
      } catch {
        // listing might not exist in marketplace yet
      }
    }

    if (!productId) {
      this.logger.warn('Cannot update inventory availability: listing not found in search projection', {
        listingId: input.listingId,
      });
      return { updated: false, reason: 'LISTING_NOT_FOUND' };
    }

    return this.withProductLock(productId, async () => {
      const doc = await this.store.getDocument(productId!);
      if (!doc) {
        return { updated: false, reason: 'PRODUCT_NOT_FOUND' };
      }

      const offerIndex = doc.offers.findIndex((o) => o.listingId === input.listingId);
      if (offerIndex < 0) {
        return { updated: false, reason: 'OFFER_NOT_FOUND' };
      }

      const existingOffer = doc.offers[offerIndex]!;
      // Stale or duplicate event protection: deterministic sourceVersion check!
      if (input.sourceVersion <= existingOffer.sourceVersion) {
        this.logger.warn('Stale or duplicate inventory availability event ignored', {
          listingId: input.listingId,
          incomingVersion: input.sourceVersion,
          existingOfferVersion: existingOffer.sourceVersion,
        });
        return { updated: false, reason: 'STALE_OR_DUPLICATE_VERSION' };
      }

      const updatedOffer: SearchSellerOffer = {
        ...existingOffer,
        inStock: input.inStock,
        availableQuantity: input.availableQuantity,
        sourceVersion: input.sourceVersion,
        updatedAt: new Date().toISOString(),
      };

      const updatedOffers = [...doc.offers];
      updatedOffers[offerIndex] = updatedOffer;

      const activeOffers = updatedOffers.filter((o) => o.status === 'ACTIVE');
      const minPrice =
        activeOffers.length > 0 ? Math.min(...activeOffers.map((o) => o.priceAmount)) : doc.minPrice;
      const maxPrice =
        activeOffers.length > 0 ? Math.max(...activeOffers.map((o) => o.priceAmount)) : doc.maxPrice;
      const hasInStockOffer = activeOffers.some((o) => o.inStock && o.availableQuantity > 0);

      const updatedDoc: SearchProductDocument = {
        ...doc,
        offers: updatedOffers,
        hasInStockOffer,
        minPrice,
        maxPrice,
        totalOffersCount: activeOffers.length,
        projectionVersion: doc.projectionVersion + 1,
        updatedAt: new Date().toISOString(),
      };

      await this.store.indexDocument(updatedDoc);
      return { updated: true };
    });
  }

  async removeProductProjection(productId: string): Promise<boolean> {
    return this.withProductLock(productId, async () => {
      return this.store.deleteDocument(productId);
    });
  }

  async removeListingProjection(
    productId: string,
    listingId: string,
  ): Promise<boolean> {
    return this.withProductLock(productId, async () => {
      const doc = await this.store.getDocument(productId);
      if (!doc) return false;

      const updatedOffers = doc.offers.filter((o) => o.listingId !== listingId);
      if (updatedOffers.length === doc.offers.length) {
        return false;
      }

      const activeOffers = updatedOffers.filter((o) => o.status === 'ACTIVE');
      const minPrice =
        activeOffers.length > 0 ? Math.min(...activeOffers.map((o) => o.priceAmount)) : 0;
      const maxPrice =
        activeOffers.length > 0 ? Math.max(...activeOffers.map((o) => o.priceAmount)) : 0;
      const hasInStockOffer = activeOffers.some((o) => o.inStock && o.availableQuantity > 0);

      const updatedDoc: SearchProductDocument = {
        ...doc,
        minPrice,
        maxPrice,
        hasInStockOffer,
        totalOffersCount: activeOffers.length,
        offers: updatedOffers,
        projectionVersion: doc.projectionVersion + 1,
        updatedAt: new Date().toISOString(),
      };

      await this.store.indexDocument(updatedDoc);
      return true;
    });
  }

  // --- Projection Rebuild API ---

  async rebuildProjection(actor: AuthorizedActor): Promise<RebuildProjectionResult> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'search:manage');
    }

    if (!this.catalogService || !this.marketplaceService || !this.inventoryService) {
      throw new Error(
        'Cannot rebuild projection: Authoritative domain services (Catalog, Marketplace, Inventory) are not configured',
      );
    }

    const startTime = Date.now();
    this.logger.info('Initiating full search projection rebuild from authoritative services');

    // 1. Fetch categories for name enrichment
    const categories = await this.catalogService.listCategories();
    const categoryMap = new Map(categories.map((c) => [c.id, c.name]));

    // 2. Fetch all products
    const products = await this.catalogService.listProducts();
    const newDocs: SearchProductDocument[] = [];
    let indexedOffersTotal = 0;

    for (const product of products) {
      const skus = await this.catalogService.listSkusByProduct(product.id);
      const offers: SearchSellerOffer[] = [];

      for (const sku of skus) {
        const activeListings = await this.marketplaceService.getActiveListingsForSku(sku.id);

        for (const listing of activeListings) {
          let merchantName: string | undefined;
          if (this.merchantService) {
            try {
              const profile = await this.merchantService.getProfileByTenantId(listing.tenantId);
              merchantName = profile?.businessName;
            } catch {
              // Graceful fallback to tenant ID
            }
          }

          let inStock = false;
          let availableQuantity = 0;
          try {
            const avail = await this.inventoryService.getAvailabilityByListingId(listing.id);
            inStock = avail.isAvailable;
            availableQuantity = avail.availableQuantity;
          } catch {
            // Graceful fallback
          }

          offers.push({
            listingId: listing.id,
            merchantId: listing.tenantId,
            merchantName,
            skuId: sku.id,
            skuCode: sku.skuCode,
            priceAmount: listing.priceAmount,
            currency: listing.currency,
            compareAtPrice: listing.compareAtPrice,
            status: listing.status,
            inStock,
            availableQuantity,
            attributes: sku.attributes ?? {},
            sourceVersion: new Date(listing.updatedAt).getTime(),
            updatedAt: listing.updatedAt,
          });
          indexedOffersTotal += 1;
        }
      }

      const activeOffers = offers.filter((o) => o.status === 'ACTIVE');
      const minPrice =
        activeOffers.length > 0 ? Math.min(...activeOffers.map((o) => o.priceAmount)) : 0;
      const maxPrice =
        activeOffers.length > 0 ? Math.max(...activeOffers.map((o) => o.priceAmount)) : 0;
      const hasInStockOffer = activeOffers.some((o) => o.inStock && o.availableQuantity > 0);

      newDocs.push({
        id: product.id,
        title: product.title,
        slug: product.slug,
        description: product.description ?? null,
        brand: product.brand ?? null,
        categoryId: product.categoryId ?? null,
        categoryName: product.categoryId ? categoryMap.get(product.categoryId) ?? null : null,
        status: product.status,
        minPrice,
        maxPrice,
        currency: activeOffers[0]?.currency ?? 'INR',
        hasInStockOffer,
        totalOffersCount: activeOffers.length,
        offers,
        // Display content rides inside attributes (persisted as JSONB by the
        // SQL store) so no projection-table migration is needed for images.
        attributes: {
          ...(product.attributes ?? {}),
          thumbnailUrl: product.thumbnailUrl ?? null,
          images: product.images ?? [],
          rating: product.rating ?? null,
          reviewCount: product.reviewCount ?? 0,
        },
        sourceVersion: new Date(product.updatedAt).getTime(),
        projectionVersion: 1,
        createdAt: product.createdAt,
        updatedAt: new Date().toISOString(),
      });
    }

    // Atomically replace projection store contents with zero downtime and version reconciliation
    await this.store.replaceProjection(newDocs);

    const durationMs = Date.now() - startTime;
    this.logger.info('Search projection rebuild completed', {
      indexedProducts: newDocs.length,
      indexedOffers: indexedOffersTotal,
      durationMs,
    });

    return {
      indexedProductsCount: newDocs.length,
      indexedOffersCount: indexedOffersTotal,
      durationMs,
      rebuiltAt: new Date().toISOString(),
    };
  }

  // --- Authoritative Domain Source Sync Operations (Immune to Client Fabrication) ---

  async syncProductFromAuthoritativeSource(
    productId: string,
  ): Promise<{ indexed: boolean; reason?: string }> {
    if (!this.catalogService) {
      throw new Error('CatalogService is required to sync product from authoritative source');
    }

    const product = await this.catalogService.getProductById(productId);
    let categoryName: string | null = null;
    if (product.categoryId) {
      try {
        const cat = await this.catalogService.getCategoryById(product.categoryId);
        categoryName = cat.name;
      } catch {
        // Fallback
      }
    }

    // Authoritative version derived strictly from database timestamp
    const authoritativeVersion = new Date(product.updatedAt).getTime();

    return this.upsertProductProjection({
      productId: product.id,
      title: product.title,
      slug: product.slug,
      description: product.description ?? null,
      brand: product.brand ?? null,
      categoryId: product.categoryId ?? null,
      categoryName,
      status: product.status,
      attributes: {
        ...(product.attributes ?? {}),
        thumbnailUrl: product.thumbnailUrl ?? null,
        images: product.images ?? [],
        rating: product.rating ?? null,
        reviewCount: product.reviewCount ?? 0,
      },
      sourceVersion: authoritativeVersion,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    });
  }

  async syncListingFromAuthoritativeSource(
    listingId: string,
  ): Promise<{ indexed: boolean; reason?: string }> {
    if (!this.marketplaceService || !this.catalogService) {
      throw new Error(
        'MarketplaceService and CatalogService are required to sync listing from authoritative source',
      );
    }

    const listing = await this.marketplaceService.getListingById(null, listingId);
    const sku = await this.catalogService.getSkuById(listing.skuId);

    let merchantName: string | undefined;
    if (this.merchantService) {
      try {
        const profile = await this.merchantService.getProfileByTenantId(listing.tenantId);
        merchantName = profile?.businessName;
      } catch {
        // Fallback
      }
    }

    let inStock = false;
    let availableQuantity = 0;
    if (this.inventoryService) {
      try {
        const avail = await this.inventoryService.getAvailabilityByListingId(listing.id);
        inStock = avail.isAvailable;
        availableQuantity = avail.availableQuantity;
      } catch {
        // Fallback
      }
    }

    // Authoritative version derived strictly from database timestamp
    const authoritativeVersion = new Date(listing.updatedAt).getTime();

    return this.upsertListingProjection({
      listingId: listing.id,
      merchantId: listing.tenantId,
      merchantName,
      productId: sku.productId,
      skuId: sku.id,
      skuCode: sku.skuCode,
      priceAmount: listing.priceAmount,
      currency: listing.currency,
      compareAtPrice: listing.compareAtPrice,
      status: listing.status,
      inStock,
      availableQuantity,
      attributes: sku.attributes ?? {},
      sourceVersion: authoritativeVersion,
      updatedAt: listing.updatedAt,
    });
  }
}
