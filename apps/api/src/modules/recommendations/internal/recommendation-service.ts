import { randomUUID } from 'node:crypto';
import type { Logger } from '../../../observability/logger.js';
import type { AuthorizedActor } from '../../identity/index.js';
import { RbacPolicy } from '../../identity/rbac/policy.js';
import { NotFoundError, ValidationError } from '../../../errors/app-error.js';
import type { CatalogService } from '../../catalog/index.js';
import type { ListingService } from '../../marketplace/index.js';
import type {
  DerivedRecommendationRecord,
  IRecommendationCandidateSource,
  IRecommendationRanker,
  IRecommendationStore,
  ListingOfferSummary,
  RankedRecommendation,
  RecommendationContext,
  RecommendationItemDto,
  RecommendationResponseDto,
  RecommendationType,
  RebuildRecommendationsResultDto,
} from './recommendation-models.js';
import { buildScopeKey } from './recommendation-store.js';
import { DeterministicRuleBasedRanker } from './recommendation-ranker.js';
import type { IAnalyticsRecommendationReader } from '../../analytics/index.js';
import {
  ColdStartCandidateSource,
  FrequentlyBoughtTogetherCandidateSource,
  PersonalizedCandidateSource,
  SimilarProductCandidateSource,
  TrendingCandidateSource,
} from './candidate-sources.js';

export interface RecommendationServiceDependencies {
  logger: Logger;
  catalogService: CatalogService;
  listingService: ListingService;
  analyticsReader: IAnalyticsRecommendationReader;
  store: IRecommendationStore;
  ranker?: IRecommendationRanker | undefined;
  trendingSource?: IRecommendationCandidateSource | undefined;
  similarSource?: IRecommendationCandidateSource | undefined;
  frequentlyBoughtTogetherSource?: IRecommendationCandidateSource | undefined;
  personalizedSource?: IRecommendationCandidateSource | undefined;
  coldStartSource?: IRecommendationCandidateSource | undefined;
}

export class RecommendationService {
  private readonly logger: Logger;
  private readonly catalogService: CatalogService;
  private readonly listingService: ListingService;
  private readonly store: IRecommendationStore;
  private readonly ranker: IRecommendationRanker;
  private readonly trendingSource: IRecommendationCandidateSource;
  private readonly similarSource: IRecommendationCandidateSource;
  private readonly frequentlyBoughtTogetherSource: IRecommendationCandidateSource;
  private readonly personalizedSource: IRecommendationCandidateSource;
  private readonly coldStartSource: IRecommendationCandidateSource;

  constructor(deps: RecommendationServiceDependencies) {
    this.logger = deps.logger.child({ module: 'recommendations' });
    this.catalogService = deps.catalogService;
    this.listingService = deps.listingService;
    this.store = deps.store;
    this.ranker = deps.ranker ?? new DeterministicRuleBasedRanker();
    this.trendingSource =
      deps.trendingSource ?? new TrendingCandidateSource(deps.analyticsReader, deps.catalogService);
    this.similarSource =
      deps.similarSource ?? new SimilarProductCandidateSource(deps.catalogService);
    this.frequentlyBoughtTogetherSource =
      deps.frequentlyBoughtTogetherSource ??
      new FrequentlyBoughtTogetherCandidateSource(deps.analyticsReader, deps.catalogService);
    this.personalizedSource =
      deps.personalizedSource ??
      new PersonalizedCandidateSource(deps.analyticsReader, deps.catalogService);
    this.coldStartSource = deps.coldStartSource ?? new ColdStartCandidateSource(deps.catalogService);
  }

  /**
   * Personalized recommendations for authenticated customer.
   * Privacy: Derived strictly from actor context (cannot query another customer).
   */
  async getPersonalizedRecommendations(
    actor: AuthorizedActor,
    options?: { limit?: number | undefined; correlationId?: string | undefined },
  ): Promise<RecommendationResponseDto> {
    RbacPolicy.requirePermission(actor, 'recommendations:read');

    // Customer identity is derived strictly from authenticated actor
    const customerId = actor.userId;
    const tenantId = actor.tenantId;
    const limit = Math.max(1, Math.min(options?.limit ?? 10, 50));

    const context: RecommendationContext = {
      tenantId,
      customerId,
      limit,
      correlationId: options?.correlationId,
    };

    let candidates = await this.personalizedSource.generateCandidates(context);
    let coldStartApplied = false;

    // Cold-start fallback if customer has no history
    if (candidates.length === 0) {
      coldStartApplied = true;
      candidates = await this.trendingSource.generateCandidates(context);
      if (candidates.length === 0) {
        candidates = await this.coldStartSource.generateCandidates(context);
      }
    }

    const ranked = await this.ranker.rank(candidates, context);
    const items = await this.decorateAndFilterEligible(ranked);

    // Save derived recommendations for fast subsequent reads
    await this.persistDerivedRecommendations(
      tenantId,
      'PERSONALIZED',
      customerId,
      null,
      items,
    );

    return {
      recommendationType: 'PERSONALIZED',
      tenantId,
      customerId,
      items,
      metadata: {
        generatedAt: new Date().toISOString(),
        rankerProvider: this.ranker.providerName,
        totalCandidatesEvaluated: candidates.length,
        count: items.length,
        coldStartApplied,
      },
    };
  }

  /**
   * Similar product recommendations based on category, brand, and deterministic similarity.
   */
  async getSimilarProducts(
    actor: AuthorizedActor,
    productId: string,
    options?: { limit?: number | undefined; correlationId?: string | undefined },
  ): Promise<RecommendationResponseDto> {
    RbacPolicy.requirePermission(actor, 'recommendations:read');

    if (!productId?.trim()) {
      throw new ValidationError('Product ID is required for similar recommendations');
    }

    // Verify source product exists and is active
    const sourceProduct = await this.catalogService.getProductById(productId);
    if (!sourceProduct || sourceProduct.status !== 'ACTIVE') {
      throw new NotFoundError(`Active product '${productId}' not found in catalog`);
    }

    const tenantId = actor.tenantId;
    const limit = Math.max(1, Math.min(options?.limit ?? 10, 50));

    const context: RecommendationContext = {
      tenantId,
      sourceProductId: productId,
      limit,
      correlationId: options?.correlationId,
    };

    let candidates = await this.similarSource.generateCandidates(context);
    let coldStartApplied = false;

    // Fallback if no similar products match
    if (candidates.length === 0) {
      coldStartApplied = true;
      candidates = await this.coldStartSource.generateCandidates(context);
    }

    const ranked = await this.ranker.rank(candidates, context);
    const items = await this.decorateAndFilterEligible(ranked);

    await this.persistDerivedRecommendations(
      tenantId,
      'SIMILAR',
      null,
      productId,
      items,
    );

    return {
      recommendationType: 'SIMILAR',
      tenantId,
      sourceProductId: productId,
      items,
      metadata: {
        generatedAt: new Date().toISOString(),
        rankerProvider: this.ranker.providerName,
        totalCandidatesEvaluated: candidates.length,
        count: items.length,
        coldStartApplied,
      },
    };
  }

  /**
   * Trending recommendations based on aggregated purchase activity in tenant.
   */
  async getTrendingRecommendations(
    actor: AuthorizedActor,
    options?: { limit?: number | undefined; correlationId?: string | undefined },
  ): Promise<RecommendationResponseDto> {
    RbacPolicy.requirePermission(actor, 'recommendations:read');

    const tenantId = actor.tenantId;
    const limit = Math.max(1, Math.min(options?.limit ?? 10, 50));

    const context: RecommendationContext = {
      tenantId,
      limit,
      correlationId: options?.correlationId,
    };

    let candidates = await this.trendingSource.generateCandidates(context);
    let coldStartApplied = false;

    if (candidates.length === 0) {
      coldStartApplied = true;
      candidates = await this.coldStartSource.generateCandidates(context);
    }

    const ranked = await this.ranker.rank(candidates, context);
    const items = await this.decorateAndFilterEligible(ranked);

    await this.persistDerivedRecommendations(
      tenantId,
      'TRENDING',
      null,
      null,
      items,
    );

    return {
      recommendationType: 'TRENDING',
      tenantId,
      items,
      metadata: {
        generatedAt: new Date().toISOString(),
        rankerProvider: this.ranker.providerName,
        totalCandidatesEvaluated: candidates.length,
        count: items.length,
        coldStartApplied,
      },
    };
  }

  /**
   * Frequently bought together recommendations based on historical co-purchases.
   */
  async getFrequentlyBoughtTogether(
    actor: AuthorizedActor,
    productId: string,
    options?: { limit?: number | undefined; correlationId?: string | undefined },
  ): Promise<RecommendationResponseDto> {
    RbacPolicy.requirePermission(actor, 'recommendations:read');

    if (!productId?.trim()) {
      throw new ValidationError('Product ID is required for frequently bought together');
    }

    const sourceProduct = await this.catalogService.getProductById(productId);
    if (!sourceProduct || sourceProduct.status !== 'ACTIVE') {
      throw new NotFoundError(`Active product '${productId}' not found in catalog`);
    }

    const tenantId = actor.tenantId;
    const limit = Math.max(1, Math.min(options?.limit ?? 10, 50));

    const context: RecommendationContext = {
      tenantId,
      sourceProductId: productId,
      limit,
      correlationId: options?.correlationId,
    };

    let candidates = await this.frequentlyBoughtTogetherSource.generateCandidates(context);
    let coldStartApplied = false;

    // Cold-start fallback: Similar products -> Cold start catalog
    if (candidates.length === 0) {
      coldStartApplied = true;
      candidates = await this.similarSource.generateCandidates(context);
      if (candidates.length === 0) {
        candidates = await this.coldStartSource.generateCandidates(context);
      }
    }

    const ranked = await this.ranker.rank(candidates, context);
    const items = await this.decorateAndFilterEligible(ranked);

    await this.persistDerivedRecommendations(
      tenantId,
      'FREQUENTLY_BOUGHT_TOGETHER',
      null,
      productId,
      items,
    );

    return {
      recommendationType: 'FREQUENTLY_BOUGHT_TOGETHER',
      tenantId,
      sourceProductId: productId,
      items,
      metadata: {
        generatedAt: new Date().toISOString(),
        rankerProvider: this.ranker.providerName,
        totalCandidatesEvaluated: candidates.length,
        count: items.length,
        coldStartApplied,
      },
    };
  }

  /**
   * Administrative Rebuild: Rebuilds derived recommendations for a tenant.
   * Deterministic, tenant-aware, idempotent, and failure-safe.
   */
  async rebuildRecommendations(
    actor: AuthorizedActor,
    targetTenantId?: string,
  ): Promise<RebuildRecommendationsResultDto> {
    RbacPolicy.requirePermission(actor, 'recommendations:rebuild');

    const effectiveTenantId =
      actor.role === 'ADMINISTRATOR' && targetTenantId ? targetTenantId : actor.tenantId;

    if (!effectiveTenantId) {
      throw new ValidationError('Tenant ID is required for recommendation rebuild');
    }

    const auditId = randomUUID();
    const startedAt = new Date().toISOString();

    this.logger.info(`Starting recommendation rebuild for tenant ${effectiveTenantId}`, {
      actorId: actor.userId,
      tenantId: effectiveTenantId,
    });

    try {
      // 1. Atomically clear previous recommendations for this tenant
      await this.store.clearTenantRecommendations(effectiveTenantId);

      let totalGenerated = 0;

      // 2. Rebuild Trending recommendations
      const trending = await this.getTrendingRecommendations(actor, { limit: 20 });
      totalGenerated += trending.items.length;

      // 3. Rebuild Similar Products for all active products in catalog
      const activeProducts = await this.catalogService.listProducts({ status: 'ACTIVE' });
      for (const prod of activeProducts) {
        const sim = await this.getSimilarProducts(actor, prod.id, { limit: 10 });
        totalGenerated += sim.items.length;

        const fbt = await this.getFrequentlyBoughtTogether(actor, prod.id, { limit: 10 });
        totalGenerated += fbt.items.length;
      }

      const completedAt = new Date().toISOString();
      const result: RebuildRecommendationsResultDto = {
        tenantId: effectiveTenantId,
        rebuiltByActorId: actor.userId,
        recommendationsGenerated: totalGenerated,
        status: 'COMPLETED',
        startedAt,
        completedAt,
      };

      await this.store.recordRebuildAudit({
        ...result,
        id: auditId,
      });

      this.logger.info(
        `Recommendation rebuild completed successfully for tenant ${effectiveTenantId}`,
        { totalGenerated },
      );

      return result;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Recommendation rebuild failed for tenant ${effectiveTenantId}: ${errorMsg}`,
      );

      await this.store.recordRebuildAudit({
        id: auditId,
        tenantId: effectiveTenantId,
        rebuiltByActorId: actor.userId,
        recommendationsGenerated: 0,
        status: 'FAILED',
        error: errorMsg,
        startedAt,
        completedAt: new Date().toISOString(),
      });

      throw err;
    }
  }

  /**
   * Invalidate recommendations for an archived or deactivated product.
   */
  async invalidateProduct(tenantId: string, productId: string): Promise<number> {
    return this.store.invalidateProduct(tenantId, productId);
  }

  /**
   * Decorates ranked recommendations with canonical product details and active seller offers.
   * Eligibility filtering:
   * - Canonical product must be ACTIVE in catalog.
   * - Only active seller offers are attached.
   * - Availability is derived (not transactional inventory guarantee).
   */
  private async decorateAndFilterEligible(
    ranked: RankedRecommendation[],
  ): Promise<RecommendationItemDto[]> {
    const items: RecommendationItemDto[] = [];

    for (const item of ranked) {
      try {
        const product = await this.catalogService.getProductById(item.productId);
        // Exclude products that are not ACTIVE
        if (!product || product.status !== 'ACTIVE') {
          continue;
        }

        // Fetch SKUs for canonical product
        const skus = await this.catalogService.listSkusByProduct(product.id);
        const activeOffers: ListingOfferSummary[] = [];

        // For each active SKU, fetch active merchant listings
        for (const sku of skus) {
          if (sku.status !== 'ACTIVE') continue;

          try {
            const listings = await this.listingService.getActiveListingsForSku(sku.id);
            for (const listing of listings) {
              if (listing.status === 'ACTIVE') {
                activeOffers.push({
                  listingId: listing.id,
                  tenantId: listing.tenantId,
                  skuId: listing.skuId,
                  priceAmount: listing.priceAmount,
                  currency: listing.currency,
                  status: listing.status,
                });
              }
            }
          } catch {
            // Non-critical if listings lookup fails
          }
        }

        items.push({
          productId: product.id,
          title: product.title,
          slug: product.slug,
          brand: product.brand ?? null,
          categoryId: product.categoryId ?? null,
          score: item.score,
          rankPosition: item.rankPosition,
          reasonCode: item.reasonCode,
          explanation: item.explanation,
          activeOffers,
          isAvailable: activeOffers.length > 0,
          derivedAt: new Date().toISOString(),
        });
      } catch {
        // Skip unresolvable products safely
      }
    }

    return items;
  }

  /**
   * Persists derived recommendations to store with deterministic uniqueness keys.
   */
  private async persistDerivedRecommendations(
    tenantId: string,
    type: RecommendationType,
    customerId: string | null,
    sourceProductId: string | null,
    items: RecommendationItemDto[],
  ): Promise<void> {
    const now = new Date().toISOString();
    const records: DerivedRecommendationRecord[] = items.map((item) => ({
      id: randomUUID(),
      scopeKey: buildScopeKey(tenantId, type, customerId, sourceProductId, item.productId),
      tenantId,
      customerId,
      recommendationType: type,
      sourceProductId,
      recommendedProductId: item.productId,
      rankPosition: item.rankPosition,
      score: item.score,
      reasonCode: item.reasonCode,
      explanation: item.explanation,
      derivedMetadata: {
        title: item.title,
        brand: item.brand,
        categoryId: item.categoryId,
        offersCount: item.activeOffers.length,
        isAvailable: item.isAvailable,
      },
      createdAt: now,
      updatedAt: now,
    }));

    await this.store.saveRecommendations(records);
  }
}
