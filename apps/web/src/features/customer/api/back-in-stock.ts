import { apiClient } from '../../../api/client';

export interface BackInStockSubscriptionProduct {
  id: string;
  title: string;
  slug?: string;
  thumbnailUrl?: string | null;
}

export interface BackInStockSubscriptionSku {
  id: string;
  skuCode: string;
}

export interface BackInStockSubscriptionDto {
  id: string;
  customerId: string;
  tenantId: string;
  productId: string;
  skuId?: string | null;
  status: 'ACTIVE' | 'NOTIFIED' | 'CANCELLED';
  createdAt: string;
  notifiedAt?: string | null;
  updatedAt: string;
  product?: BackInStockSubscriptionProduct;
  sku?: BackInStockSubscriptionSku | null;
}

export interface BackInStockCheckResult {
  isSubscribed: boolean;
  subscriptionId?: string | null;
  status?: 'ACTIVE' | 'NOTIFIED' | 'CANCELLED' | null;
}

export const backInStockApi = {
  getSubscriptions: async (): Promise<BackInStockSubscriptionDto[]> => {
    return apiClient<BackInStockSubscriptionDto[]>('/customer/back-in-stock');
  },

  subscribe: async (productId: string, skuId?: string): Promise<BackInStockSubscriptionDto> => {
    return apiClient<BackInStockSubscriptionDto>('/customer/back-in-stock', {
      method: 'POST',
      body: JSON.stringify({ productId, skuId }),
    });
  },

  cancelSubscription: async (productId: string): Promise<{ success: boolean; message: string }> => {
    return apiClient<{ success: boolean; message: string }>(`/customer/back-in-stock/${productId}`, {
      method: 'DELETE',
    });
  },

  checkSubscription: async (productId: string): Promise<BackInStockCheckResult> => {
    return apiClient<BackInStockCheckResult>(`/customer/back-in-stock/check/${productId}`);
  },
};
