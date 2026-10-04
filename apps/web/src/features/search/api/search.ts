import { apiClient } from '../../../api/client';

export type SearchSortBy = 'relevance' | 'price_asc' | 'price_desc' | 'newest';

export interface SearchSellerOffer {
  listingId: string;
  merchantId: string;
  merchantName?: string;
  skuId: string;
  skuCode: string;
  priceAmount: number; // Minor currency units (e.g. cents, paise)
  currency: string;
  compareAtPrice?: number | null;
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  inStock: boolean;
  availableQuantity: number;
  attributes: Record<string, unknown>;
  sourceVersion: number;
  updatedAt: string;
}

export interface SearchProductResultDto {
  productId: string;
  title: string;
  slug: string;
  description?: string | null;
  brand?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  minPrice: number;
  maxPrice: number;
  currency: string;
  hasInStockOffer: boolean;
  totalOffersCount: number;
  bestOffer?: SearchSellerOffer | null;
  matchedOffer?: SearchSellerOffer | null;
  offers: SearchSellerOffer[];
  attributes: Record<string, unknown>;
  score?: number;
  projectionVersion: number;
  updatedAt: string;
}

export interface FacetCategory {
  id: string;
  name: string;
  count: number;
}

export interface FacetBrand {
  name: string;
  count: number;
}

export interface FacetMerchant {
  id: string;
  name: string;
  count: number;
}

export interface SearchFacets {
  categories: FacetCategory[];
  brands: FacetBrand[];
  merchants: FacetMerchant[];
  priceRange: {
    min: number;
    max: number;
  };
}

export interface SearchResponseDto {
  items: SearchProductResultDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  query?: string;
  facets: SearchFacets;
}

export interface SearchQueryParams {
  q?: string | undefined;
  categoryId?: string | undefined;
  merchantId?: string | undefined;
  brand?: string | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  inStock?: boolean | undefined;
  sortBy?: SearchSortBy | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export const searchApi = {
  search: async (params: SearchQueryParams = {}): Promise<SearchResponseDto> => {
    const query = new URLSearchParams();
    if (params.q) query.append('q', params.q);
    if (params.categoryId) query.append('categoryId', params.categoryId);
    if (params.merchantId) query.append('merchantId', params.merchantId);
    if (params.brand) query.append('brand', params.brand);
    if (params.minPrice !== undefined) query.append('minPrice', params.minPrice.toString());
    if (params.maxPrice !== undefined) query.append('maxPrice', params.maxPrice.toString());
    if (params.inStock !== undefined) query.append('inStock', params.inStock.toString());
    if (params.sortBy) query.append('sortBy', params.sortBy);
    if (params.page !== undefined) query.append('page', params.page.toString());
    if (params.pageSize !== undefined) query.append('pageSize', params.pageSize.toString());

    const qs = query.toString();
    return apiClient<SearchResponseDto>(`/search${qs ? `?${qs}` : ''}`);
  },

  getDocumentById: async (productId: string): Promise<SearchProductResultDto> => {
    return apiClient<SearchProductResultDto>(`/search/documents/${productId}`);
  },
};
