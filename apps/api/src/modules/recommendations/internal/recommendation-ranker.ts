import type {
  IRecommendationRanker,
  RankedRecommendation,
  RecommendationCandidate,
  RecommendationContext,
  RecommendationReasonCode,
} from './recommendation-models.js';

export interface RankerWeights {
  eligibilityWeight: number;
  categoryRelevanceWeight: number;
  coPurchaseWeight: number;
  popularityWeight: number;
  affinityWeight: number;
  stalenessPenaltyWeight: number;
}

export const DEFAULT_RANKER_WEIGHTS: RankerWeights = {
  eligibilityWeight: 10.0,
  categoryRelevanceWeight: 25.0,
  coPurchaseWeight: 35.0,
  popularityWeight: 20.0,
  affinityWeight: 10.0,
  stalenessPenaltyWeight: 5.0,
};

export class DeterministicRuleBasedRanker implements IRecommendationRanker {
  readonly providerName = 'deterministic-rule-ranker-v1';

  constructor(private readonly weights: RankerWeights = DEFAULT_RANKER_WEIGHTS) {}

  async rank(
    candidates: RecommendationCandidate[],
    context: RecommendationContext,
  ): Promise<RankedRecommendation[]> {
    if (candidates.length === 0) {
      return [];
    }

    const scoredItems: Array<{
      productId: string;
      finalScore: number;
      reasonCode: RecommendationReasonCode;
      explanation: string;
      metadata: Record<string, unknown>;
    }> = [];

    for (const candidate of candidates) {
      // 1. Eligibility component (base eligibility is always satisfied if candidate reached ranker)
      const eligibilityScore = this.weights.eligibilityWeight;

      // 2. Category relevance component [0.0 - 1.0 normalized]
      const categoryScore =
        (candidate.categoryMatchScore ?? 0) * this.weights.categoryRelevanceWeight;

      // 3. Co-purchase strength component [0.0 - 1.0 normalized based on coPurchaseCount]
      const rawCoPurchase = candidate.coPurchaseCount ?? 0;
      const normalizedCoPurchase = Math.min(1.0, rawCoPurchase / 10.0);
      const coPurchaseScore = normalizedCoPurchase * this.weights.coPurchaseWeight;

      // 4. Recent popularity component [0.0 - 1.0 normalized based on recent units sold]
      const rawUnits = candidate.recentUnitsSold ?? 0;
      const normalizedPopularity = Math.min(1.0, rawUnits / 50.0);
      const popularityScore = normalizedPopularity * this.weights.popularityWeight;

      // 5. Customer affinity component [0.0 - 1.0]
      const affinityScore = (candidate.affinityScore ?? 0) * this.weights.affinityWeight;

      // 6. Base candidate score contribution
      const baseContribution = candidate.baseScore;

      // Total deterministic composite score
      const compositeScore =
        baseContribution +
        eligibilityScore +
        categoryScore +
        coPurchaseScore +
        popularityScore +
        affinityScore;

      // Round to 4 decimal places for stable deterministic consistency
      const finalScore = Number(compositeScore.toFixed(4));

      // Determine explanation and reason code
      const { reasonCode, explanation } = this.determineExplanation(candidate, {
        categoryScore,
        coPurchaseScore,
        popularityScore,
        affinityScore,
      });

      scoredItems.push({
        productId: candidate.productId,
        finalScore,
        reasonCode,
        explanation,
        metadata: {
          ...candidate.metadata,
          scoredBy: this.providerName,
          signals: {
            eligibilityScore,
            categoryScore: Number(categoryScore.toFixed(2)),
            coPurchaseScore: Number(coPurchaseScore.toFixed(2)),
            popularityScore: Number(popularityScore.toFixed(2)),
            affinityScore: Number(affinityScore.toFixed(2)),
          },
        },
      });
    }

    // Deterministic Sort: score DESC, then stable product ID ASC
    scoredItems.sort((a, b) => {
      if (b.finalScore !== a.finalScore) {
        return b.finalScore - a.finalScore;
      }
      return a.productId.localeCompare(b.productId);
    });

    const limit = Math.max(1, Math.min(context.limit ?? 20, 100));
    const sliced = scoredItems.slice(0, limit);

    return sliced.map((item, index) => ({
      productId: item.productId,
      rankPosition: index + 1,
      score: item.finalScore,
      reasonCode: item.reasonCode,
      explanation: item.explanation,
      metadata: item.metadata,
    }));
  }

  private determineExplanation(
    candidate: RecommendationCandidate,
    signals: {
      categoryScore: number;
      coPurchaseScore: number;
      popularityScore: number;
      affinityScore: number;
    },
  ): { reasonCode: RecommendationReasonCode; explanation: string } {
    // If the candidate already has an explicit COLD_START_FALLBACK, preserve it
    if (candidate.reasonCode === 'COLD_START_FALLBACK') {
      return {
        reasonCode: 'COLD_START_FALLBACK',
        explanation:
          candidate.explanation ||
          'Recommended via catalogue fallback due to insufficient historical activity.',
      };
    }

    // Otherwise determine based on the dominant scoring signal
    const maxSignal = Math.max(
      signals.coPurchaseScore,
      signals.categoryScore,
      signals.popularityScore,
      signals.affinityScore,
    );

    if (maxSignal === signals.coPurchaseScore && signals.coPurchaseScore > 0) {
      return {
        reasonCode: 'FREQUENTLY_BOUGHT_TOGETHER',
        explanation:
          candidate.explanation ||
          'Frequently purchased together with items in your order history.',
      };
    }

    if (maxSignal === signals.affinityScore && signals.affinityScore > 0) {
      return {
        reasonCode: 'PERSONALIZED_HISTORY',
        explanation:
          candidate.explanation ||
          'Recommended based on your recent purchasing patterns and brand preferences.',
      };
    }

    if (maxSignal === signals.popularityScore && signals.popularityScore > 0) {
      return {
        reasonCode: 'TRENDING',
        explanation:
          candidate.explanation ||
          'Currently popular with strong recent purchase volume across the marketplace.',
      };
    }

    if (maxSignal === signals.categoryScore && signals.categoryScore > 0) {
      return {
        reasonCode: 'CATEGORY_MATCH',
        explanation: candidate.explanation || 'Matches related categories and product attributes.',
      };
    }

    return {
      reasonCode: candidate.reasonCode,
      explanation: candidate.explanation,
    };
  }
}
