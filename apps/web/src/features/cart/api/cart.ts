import { apiClient } from '../../../api/client';

export interface CartItemDto {
  id: string;
  listingId: string;
  skuId: string;
  merchantTenantId: string;
  productId?: string | null;
  productTitle?: string | null;
  productBrand?: string | null;
  productThumbnailUrl?: string | null;
  quantity: number;
  unitPriceAmount: number;
  lineTotalAmount: number;
  currency: string;
  listingStatus: string;
  isAvailable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CartDto {
  id: string;
  tenantId: string;
  status: string;
  items: CartItemDto[];
  itemCount: number;
  subtotalAmount: number;
  currency: string | null;
  createdAt: string;
  updatedAt: string;
}

export const cartApi = {
  getCart: async (): Promise<CartDto> => {
    return apiClient<CartDto>('/cart');
  },

  addItem: async (listingId: string, quantity = 1): Promise<CartDto> => {
    return apiClient<CartDto>('/cart/items', {
      method: 'POST',
      body: JSON.stringify({ listingId, quantity }),
    });
  },

  updateQuantity: async (itemId: string, quantity: number): Promise<CartDto> => {
    return apiClient<CartDto>(`/cart/items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ quantity }),
    });
  },

  removeItem: async (itemId: string): Promise<CartDto> => {
    return apiClient<CartDto>(`/cart/items/${itemId}`, {
      method: 'DELETE',
    });
  },

  clearCart: async (): Promise<void> => {
    return apiClient<void>('/cart', {
      method: 'DELETE',
    });
  },
};
