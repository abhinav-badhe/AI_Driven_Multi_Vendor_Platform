export interface WishlistItemRow {
  id: string;
  customer_id: string;
  tenant_id: string;
  product_id: string;
  sku_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface WishlistProductSummary {
  id: string;
  title: string;
  slug: string;
  brand: string | null;
  thumbnailUrl: string | null;
  images: string[];
  status: string;
  rating: number | null;
  reviewCount: number;
}

export interface WishlistSkuSummary {
  id: string;
  skuCode: string;
  attributes: Record<string, unknown>;
}

export interface WishlistOfferSummary {
  listingId: string;
  merchantTenantId: string;
  priceAmount: number;
  currency: string;
  compareAtPrice: number | null;
}

export interface WishlistAvailabilitySummary {
  isAvailable: boolean;
  availableQuantity: number;
  status: 'IN_STOCK' | 'OUT_OF_STOCK' | 'UNAVAILABLE';
}

export interface WishlistItemDto {
  id: string;
  customerId: string;
  tenantId: string;
  productId: string;
  skuId: string | null;
  product: WishlistProductSummary;
  sku: WishlistSkuSummary | null;
  offer: WishlistOfferSummary | null;
  availability: WishlistAvailabilitySummary;
  createdAt: string;
  updatedAt: string;
}

export interface AddWishlistItemInput {
  productId: string;
  skuId?: string | null | undefined;
}

export interface SaveForLaterInput {
  cartItemId: string;
}

export interface MoveToCartInput {
  listingId?: string | undefined;
}

export interface WishlistCheckResultDto {
  isWishlisted: boolean;
  wishlistItemId?: string | null;
}
