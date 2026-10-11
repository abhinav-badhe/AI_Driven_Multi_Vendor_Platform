import type { IAnalyticsRecommendationReader } from '../../analytics/index.js';
import type { CatalogService, ICatalogReader } from '../../catalog/index.js';
import type {
  IRecommendationCandidateSource,
  RecommendationCandidate,
  RecommendationContext,
} from './recommendation-models.js';

/**
 * Trending candidate source: consumes aggregate popularity signals via typed Analytics read interface.
 */
export class TrendingCandidateSource implements IRecommendationCandidateSource {
  readonly name = 'trending-candidate-source';

  constructor(
    private readonly analyticsReader: IAnalyticsRecommendationReader,
    private readonly catalogService: ICatalogReader | CatalogService,
  ) {}

  async generateCandidates(context: RecommendationContext): Promise<RecommendationCandidate[]> {
    const { tenantId, limit = 20 } = context;

    const signals = await this.analyticsReader.getTrendingProducts(tenantId, limit);
    const candidates: RecommendationCandidate[] = [];

    for (const sig of signals) {
      try {
        const prod = await this.catalogService.getProductById(sig.productId);
        if (prod.status !== 'ACTIVE') continue;

        const hasPurchases = sig.unitsSold > 0;
        candidates.push({
          productId: prod.id,
          baseScore: hasPurchases ? 50.0 : 10.0,
          recentUnitsSold: sig.unitsSold,
          reasonCode: hasPurchases ? 'TRENDING' : 'POPULAR_IN_CATEGORY',
          explanation: hasPurchases
            ? `Trending product with ${sig.unitsSold} recent units ordered across ${sig.orderCount} transactions.`
            : 'Featured catalog product available in your marketplace.',
          metadata: {
            unitsSold: sig.unitsSold,
            orderCount: sig.orderCount,
            categoryId: prod.categoryId,
            brand: prod.brand,
          },
        });
      } catch {
        // Skip products that cannot be resolved in catalog
      }
    }

    return candidates;
  }
}

/**
 * Similar Products candidate source: deterministic category, brand, and attribute similarity
 * via authorized Catalog read interface.
 */
export class SimilarProductCandidateSource implements IRecommendationCandidateSource {
  readonly name = 'similar-product-candidate-source';

  constructor(private readonly catalogService: ICatalogReader | CatalogService) {}

  async generateCandidates(context: RecommendationContext): Promise<RecommendationCandidate[]> {
    const { sourceProductId, limit = 20 } = context;
    if (!sourceProductId) return [];

    let sourceProduct;
    try {
      sourceProduct = await this.catalogService.getProductById(sourceProductId);
    } catch {
      return [];
    }

    if (!sourceProduct || sourceProduct.status !== 'ACTIVE') return [];

    const allActive = await this.catalogService.listProducts({ status: 'ACTIVE' });
    const candidates: RecommendationCandidate[] = [];

    for (const prod of allActive) {
      if (prod.id === sourceProductId) continue;

      const isCategoryMatch = Boolean(
        sourceProduct.categoryId && prod.categoryId === sourceProduct.categoryId,
      );
      const isBrandMatch = Boolean(
        sourceProduct.brand && prod.brand && prod.brand === sourceProduct.brand,
      );

      if (!isCategoryMatch && !isBrandMatch) continue;

      let sim = 0.2;
      let reasonCode: 'SIMILAR_PRODUCT' | 'CATEGORY_MATCH' = 'SIMILAR_PRODUCT';
      let explanation = 'Similar product in our catalog.';

      if (isCategoryMatch && isBrandMatch) {
        sim = 1.0;
        explanation = `Matches category and brand '${sourceProduct.brand}'.`;
      } else if (isCategoryMatch) {
        sim = 0.8;
        reasonCode = 'CATEGORY_MATCH';
        explanation = 'Matches the same product category.';
      } else if (isBrandMatch) {
        sim = 0.6;
        explanation = `From the same brand '${sourceProduct.brand}'.`;
      }

      candidates.push({
        productId: prod.id,
        sourceProductId,
        baseScore: 40.0,
        categoryMatchScore: sim,
        reasonCode,
        explanation,
        metadata: {
          sourceProductId,
          categoryId: prod.categoryId,
          brand: prod.brand,
          similarityScore: sim,
        },
      });
    }

    candidates.sort((a, b) => {
      const scoreA = a.categoryMatchScore ?? 0;
      const scoreB = b.categoryMatchScore ?? 0;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return a.productId.localeCompare(b.productId);
    });

    return candidates.slice(0, limit);
  }
}

/**
 * Frequently Bought Together candidate source: historical co-purchases
 * consumed via typed Analytics read interface.
 */
export class FrequentlyBoughtTogetherCandidateSource implements IRecommendationCandidateSource {
  readonly name = 'frequently-bought-together-candidate-source';

  constructor(
    private readonly analyticsReader: IAnalyticsRecommendationReader,
    private readonly catalogService: ICatalogReader | CatalogService,
  ) {}

  async generateCandidates(context: RecommendationContext): Promise<RecommendationCandidate[]> {
    const { tenantId, sourceProductId, limit = 20 } = context;
    if (!sourceProductId) return [];

    const signals = await this.analyticsReader.getCoPurchasedProducts(
      tenantId,
      sourceProductId,
      limit,
    );

    const candidates: RecommendationCandidate[] = [];
    for (const sig of signals) {
      try {
        const prod = await this.catalogService.getProductById(sig.productId);
        if (prod.status !== 'ACTIVE') continue;

        candidates.push({
          productId: prod.id,
          sourceProductId,
          baseScore: 45.0,
          coPurchaseCount: sig.coPurchaseCount,
          reasonCode: 'FREQUENTLY_BOUGHT_TOGETHER',
          explanation: `Frequently bought together with this product (${sig.coPurchaseCount} co-purchases).`,
          metadata: {
            sourceProductId,
            coPurchaseCount: sig.coPurchaseCount,
            categoryId: prod.categoryId,
            brand: prod.brand,
          },
        });
      } catch {
        // Skip unresolvable products safely
      }
    }

    return candidates;
  }
}

/**
 * Personalized candidate source: uses customer purchase history
 * consumed via typed Analytics read interface and matched against Catalog.
 */
export class PersonalizedCandidateSource implements IRecommendationCandidateSource {
  readonly name = 'personalized-candidate-source';

  constructor(
    private readonly analyticsReader: IAnalyticsRecommendationReader,
    private readonly catalogService: ICatalogReader | CatalogService,
  ) {}

  async generateCandidates(context: RecommendationContext): Promise<RecommendationCandidate[]> {
    const { tenantId, customerId, limit = 20 } = context;
    if (!customerId) return [];

    const historySignals = await this.analyticsReader.getCustomerPurchaseHistory(
      tenantId,
      customerId,
    );

    if (historySignals.length === 0) {
      // Customer has zero historical activity -> Cold start fallback
      return [];
    }

    const purchasedProductIds = new Set(historySignals.map((s) => s.productId));
    const topCategories: string[] = [];
    const topBrands: string[] = [];

    for (const sig of historySignals) {
      try {
        const prod = await this.catalogService.getProductById(sig.productId);
        if (prod.categoryId && !topCategories.includes(prod.categoryId)) {
          topCategories.push(prod.categoryId);
        }
        if (prod.brand && !topBrands.includes(prod.brand)) {
          topBrands.push(prod.brand);
        }
      } catch {
        // Skip historical products no longer present
      }
    }

    const allActive = await this.catalogService.listProducts({ status: 'ACTIVE' });
    const candidates: RecommendationCandidate[] = [];

    for (const prod of allActive) {
      const isCategoryMatch = Boolean(prod.categoryId && topCategories.includes(prod.categoryId));
      const isBrandMatch = Boolean(prod.brand && topBrands.includes(prod.brand));

      if (!isCategoryMatch && !isBrandMatch) continue;

      const alreadyBought = purchasedProductIds.has(prod.id);
      const affinityScore = alreadyBought ? 0.3 : 0.9;

      let explanation = 'Recommended based on your previous order history.';
      if (isCategoryMatch && isBrandMatch) {
        explanation = `Matches your affinity for ${prod.brand} and related products.`;
      } else if (isCategoryMatch) {
        explanation = 'Recommended based on categories you regularly purchase.';
      }

      candidates.push({
        productId: prod.id,
        baseScore: alreadyBought ? 30.0 : 50.0,
        affinityScore,
        categoryMatchScore: isCategoryMatch ? 0.8 : 0.4,
        reasonCode: 'PERSONALIZED_HISTORY',
        explanation,
        metadata: {
          customerId,
          alreadyBought,
          categoryId: prod.categoryId,
          brand: prod.brand,
        },
      });

      if (candidates.length >= limit * 2) break;
    }

    return candidates.slice(0, limit);
  }
}

/**
 * Cold Start Fallback Source: Ensures deterministic fallback from Catalog.
 */
export class ColdStartCandidateSource implements IRecommendationCandidateSource {
  readonly name = 'cold-start-candidate-source';

  constructor(private readonly catalogService: ICatalogReader | CatalogService) {}

  async generateCandidates(context: RecommendationContext): Promise<RecommendationCandidate[]> {
    const { sourceProductId, limit = 20 } = context;

    const allActive = await this.catalogService.listProducts({ status: 'ACTIVE' });

    // Deterministic fallback: sorted by title ASC, then id ASC
    const filtered = allActive
      .filter((p) => p.id !== sourceProductId)
      .sort((a, b) => {
        const titleCompare = a.title.localeCompare(b.title);
        if (titleCompare !== 0) return titleCompare;
        return a.id.localeCompare(b.id);
      });

    const candidates: RecommendationCandidate[] = [];
    for (const prod of filtered) {
      candidates.push({
        productId: prod.id,
        sourceProductId: sourceProductId ?? null,
        baseScore: 25.0,
        reasonCode: 'COLD_START_FALLBACK',
        explanation: 'Popular catalog item recommended for new customers.',
        metadata: {
          isColdStart: true,
          categoryId: prod.categoryId,
          brand: prod.brand,
        },
      });

      if (candidates.length >= limit) break;
    }

    return candidates;
  }
}
