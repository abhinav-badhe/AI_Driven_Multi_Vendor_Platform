import { apiClient } from '../../../api/client';
import type { CartDto } from '../../cart/api/cart';

export interface WishlistProductSummary {
  id: string;
  title: string;
  slug: string;
  brand?: string | null;
  thumbnailUrl?: string | null;
  images: string[];
  status: string;
  rating?: number | null;
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
  compareAtPrice?: number | null;
}

export interface WishlistAvailabilitySummary {
  isAvailable: boolean;
  availableQuantity: number;
  status: 'IN_STOCK' | 'OUT_OF_STOCK' | 'UNAVAILABLE';
}

export interface WishlistItem {
  id: string;
  customerId: string;
  tenantId: string;
  productId: string;
  skuId?: string | null;
  product: WishlistProductSummary;
  sku?: WishlistSkuSummary | null;
  offer?: WishlistOfferSummary | null;
  availability: WishlistAvailabilitySummary;
  createdAt: string;
  updatedAt: string;
}

export interface WishlistCheckResult {
  isWishlisted: boolean;
  wishlistItemId?: string | null;
}

export const wishlistApi = {
  getWishlist: async (): Promise<WishlistItem[]> => {
    return apiClient<WishlistItem[]>('/customer/wishlist');
  },

  addToWishlist: async (productId: string, skuId?: string): Promise<WishlistItem> => {
    return apiClient<WishlistItem>('/customer/wishlist', {
      method: 'POST',
      body: JSON.stringify({ productId, skuId }),
    });
  },

  removeFromWishlist: async (productId: string): Promise<void> => {
    await apiClient<void>(`/customer/wishlist/${productId}`, {
      method: 'DELETE',
    });
  },

  checkWishlist: async (productId: string): Promise<WishlistCheckResult> => {
    return apiClient<WishlistCheckResult>(`/customer/wishlist/check/${productId}`);
  },

  saveForLater: async (cartItemId: string): Promise<{ wishlistItem: WishlistItem; cart: CartDto }> => {
    return apiClient<{ wishlistItem: WishlistItem; cart: CartDto }>('/customer/wishlist/save-for-later', {
      method: 'POST',
      body: JSON.stringify({ cartItemId }),
    });
  },

  moveToCart: async (productId: string, listingId?: string): Promise<{ cart: CartDto; message: string }> => {
    return apiClient<{ cart: CartDto; message: string }>(`/customer/wishlist/${productId}/move-to-cart`, {
      method: 'POST',
      body: JSON.stringify({ listingId }),
    });
  },
};
