/**
 * Recommendation domain models, types, reason codes, and provider interfaces.
 * Phase 12 - Recommendations
 */

export type RecommendationType =
  | 'PERSONALIZED'
  | 'SIMILAR'
  | 'TRENDING'
  | 'FREQUENTLY_BOUGHT_TOGETHER';

export type RecommendationReasonCode =
  | 'TRENDING'
  | 'SIMILAR_PRODUCT'
  | 'FREQUENTLY_BOUGHT_TOGETHER'
  | 'PERSONALIZED_HISTORY'
  | 'CATEGORY_MATCH'
  | 'POPULAR_IN_CATEGORY'
  | 'COLD_START_FALLBACK';

export interface RecommendationCandidate {
  productId: string;
  sourceProductId?: string | null | undefined;
  baseScore: number;
  reasonCode: RecommendationReasonCode;
  explanation: string;
  categoryMatchScore?: number | undefined;
  coPurchaseCount?: number | undefined;
  recentUnitsSold?: number | undefined;
  affinityScore?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface RecommendationContext {
  tenantId: string;
  customerId?: string | null | undefined;
  sourceProductId?: string | null | undefined;
  limit?: number | undefined;
  correlationId?: string | undefined;
  categoryFilter?: string | null | undefined;
}

export interface RankedRecommendation {
  productId: string;
  rankPosition: number;
  score: number;
  reasonCode: RecommendationReasonCode;
  explanation: string;
  metadata: Record<string, unknown>;
}

export interface DerivedRecommendationRecord {
  id: string;
  scopeKey: string;
  tenantId: string;
  customerId?: string | null | undefined;
  recommendationType: RecommendationType;
  sourceProductId?: string | null | undefined;
  recommendedProductId: string;
  rankPosition: number;
  score: number;
  reasonCode: RecommendationReasonCode;
  explanation: string;
  derivedMetadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string | null | undefined;
}

export interface ListingOfferSummary {
  listingId: string;
  tenantId: string;
  skuId: string;
  priceAmount: number;
  currency: string;
  status: string;
}

export interface RecommendationItemDto {
  productId: string;
  title: string;
  slug: string;
  brand?: string | null | undefined;
  categoryId?: string | null | undefined;
  score: number;
  rankPosition: number;
  reasonCode: RecommendationReasonCode;
  explanation: string;
  activeOffers: ListingOfferSummary[];
  isAvailable: boolean;
  derivedAt: string;
}

export interface RecommendationResponseDto {
  recommendationType: RecommendationType;
  tenantId: string;
  customerId?: string | null | undefined;
  sourceProductId?: string | null | undefined;
  items: RecommendationItemDto[];
  metadata: {
    generatedAt: string;
    rankerProvider: string;
    totalCandidatesEvaluated: number;
    count: number;
    coldStartApplied: boolean;
  };
}

export interface RebuildRecommendationsResultDto {
  tenantId: string;
  rebuiltByActorId: string;
  recommendationsGenerated: number;
  status: 'COMPLETED' | 'FAILED';
  startedAt: string;
  completedAt: string;
  error?: string | undefined;
}

/**
 * Extensible Candidate Source Interface
 */
export interface IRecommendationCandidateSource {
  readonly name: string;
  generateCandidates(context: RecommendationContext): Promise<RecommendationCandidate[]>;
}

/**
 * Extensible Ranker Interface (Allows Phase 13 ML to substitute Deterministic Ranker)
 */
export interface IRecommendationRanker {
  readonly providerName: string;
  rank(
    candidates: RecommendationCandidate[],
    context: RecommendationContext,
  ): Promise<RankedRecommendation[]>;
}

/**
 * Derived Recommendation Store Interface
 */
export interface IRecommendationStore {
  saveRecommendations(records: DerivedRecommendationRecord[]): Promise<void>;
  getRecommendations(
    tenantId: string,
    type: RecommendationType,
    options?: {
      customerId?: string | null;
      sourceProductId?: string | null;
      limit?: number;
    },
  ): Promise<DerivedRecommendationRecord[]>;
  deleteByScope(
    tenantId: string,
    type: RecommendationType,
    customerId?: string | null,
    sourceProductId?: string | null,
  ): Promise<number>;
  clearTenantRecommendations(tenantId: string): Promise<number>;
  invalidateProduct(tenantId: string, productId: string): Promise<number>;
  recordRebuildAudit(
    audit: Omit<RebuildRecommendationsResultDto, 'status'> & {
      id: string;
      status: 'COMPLETED' | 'FAILED';
    },
  ): Promise<void>;
}
