/**
 * Search Bounded Context - Derived Read Model Schemas & Contracts
 *
 * CRITICAL ARCHITECTURAL INVARIANT:
 * Search is a derived read model. It does NOT own transactional truth.
 * - Product identity is owned authoritatively by Catalog.
 * - Listing commercial terms are owned authoritatively by Marketplace.
 * - Inventory availability is owned authoritatively by Inventory.
 * - Prices and stock in search documents are derived snapshots for discovery only.
 * - Checkout and Inventory revalidate authoritative facts at transaction time.
 */

export type SearchSortBy = 'relevance' | 'price_asc' | 'price_desc' | 'newest';

export interface SearchSellerOffer {
  listingId: string;
  merchantId: string;
  merchantName?: string | undefined;
  skuId: string;
  skuCode: string;
  priceAmount: number; // Minor currency units (e.g. cents, paise)
  currency: string;
  compareAtPrice?: number | null | undefined;
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  inStock: boolean;
  availableQuantity: number;
  attributes: Record<string, unknown>;
  sourceVersion: number;
  updatedAt: string;
}

export interface SearchProductDocument {
  id: string; // Canonical Product ID
  title: string;
  slug: string;
  description?: string | null | undefined;
  brand?: string | null | undefined;
  categoryId?: string | null | undefined;
  categoryName?: string | null | undefined;
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  minPrice: number;
  maxPrice: number;
  currency: string;
  hasInStockOffer: boolean;
  totalOffersCount: number;
  offers: SearchSellerOffer[];
  attributes: Record<string, unknown>;
  sourceVersion: number;
  projectionVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface SearchQueryParams {
  q?: string | undefined;
  categoryId?: string | undefined;
  merchantId?: string | undefined;
  brand?: string | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  inStock?: boolean | undefined;
  attributes?: Record<string, string | number | boolean> | undefined;
  sortBy?: SearchSortBy | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
  includeInactive?: boolean | undefined; // Allowed only for platform administrators
}

export interface SearchProductResultDto {
  productId: string;
  title: string;
  slug: string;
  description?: string | null | undefined;
  brand?: string | null | undefined;
  categoryId?: string | null | undefined;
  categoryName?: string | null | undefined;
  minPrice: number;
  maxPrice: number;
  currency: string;
  hasInStockOffer: boolean;
  totalOffersCount: number;
  bestOffer?: SearchSellerOffer | null | undefined;
  matchedOffer?: SearchSellerOffer | null | undefined;
  offers: SearchSellerOffer[];
  attributes: Record<string, unknown>;
  score?: number | undefined;
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
  query?: string | undefined;
  facets: SearchFacets;
}

// --- Projection Synchronization Inputs ---

export interface UpsertProductProjectionInput {
  productId: string;
  title: string;
  slug: string;
  description?: string | null | undefined;
  brand?: string | null | undefined;
  categoryId?: string | null | undefined;
  categoryName?: string | null | undefined;
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  attributes?: Record<string, unknown> | undefined;
  sourceVersion: number;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface UpsertListingProjectionInput {
  listingId: string;
  merchantId: string;
  merchantName?: string | undefined;
  productId: string;
  skuId: string;
  skuCode: string;
  priceAmount: number;
  currency: string;
  compareAtPrice?: number | null | undefined;
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  inStock: boolean;
  availableQuantity: number;
  attributes?: Record<string, unknown> | undefined;
  sourceVersion: number;
  updatedAt?: string | undefined;
}

export interface RebuildProjectionResult {
  indexedProductsCount: number;
  indexedOffersCount: number;
  durationMs: number;
  rebuiltAt: string;
}
