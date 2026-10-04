import { apiClient } from '../../../api/client';

export interface RecommendationOfferSummary {
  listingId: string;
  merchantTenantId: string;
  priceAmount: number;
  currency: string;
  isAvailable: boolean;
}

export interface RecommendationItemDto {
  productId: string;
  title: string;
  slug: string;
  brand?: string | null;
  categoryId?: string | null;
  score: number;
  rankPosition: number;
  reasonCode: string;
  explanation: string;
  activeOffers: RecommendationOfferSummary[];
  isAvailable: boolean;
  derivedAt: string;
}

export interface RecommendationResponseDto {
  recommendationType: string;
  tenantId: string;
  customerId?: string | null;
  sourceProductId?: string | null;
  items: RecommendationItemDto[];
  metadata: {
    generatedAt: string;
    rankerProvider: string;
    totalCandidatesEvaluated: number;
    count: number;
    coldStartApplied: boolean;
  };
}

export const recommendationsApi = {
  getPersonalized: async (limit = 6): Promise<RecommendationResponseDto> => {
    return apiClient<RecommendationResponseDto>(`/recommendations?limit=${limit}`);
  },

  getTrending: async (limit = 6): Promise<RecommendationResponseDto> => {
    return apiClient<RecommendationResponseDto>(`/recommendations/trending?limit=${limit}`);
  },

  getSimilar: async (productId: string, limit = 4): Promise<RecommendationResponseDto> => {
    return apiClient<RecommendationResponseDto>(`/recommendations/similar/${productId}?limit=${limit}`);
  },
};
