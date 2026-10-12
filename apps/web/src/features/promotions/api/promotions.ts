import { apiClient } from '../../../api/client';

export interface PromotionDto {
  id: string;
  name: string;
  description?: string | null;
  merchantTenantId?: string | null;
  code?: string | null;
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  discountValue: number;
  currency: string;
  scope: 'ORDER' | 'PRODUCT' | 'CATEGORY';
  targetIds: string[];
  minOrderAmount: number;
  maxDiscountAmount?: number | null;
  startsAt: string;
  expiresAt?: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  usageLimitTotal?: number | null;
  usageLimitPerCustomer?: number | null;
  currentUsageCount: number;
  firstOrderOnly: boolean;
  stackable: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePromotionPayload {
  name: string;
  description?: string | undefined;
  merchantTenantId?: string | undefined;
  code?: string | undefined;
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  discountValue: number;
  currency?: string | undefined;
  scope?: 'ORDER' | 'PRODUCT' | 'CATEGORY' | undefined;
  targetIds?: string[] | undefined;
  minOrderAmount?: number | undefined;
  maxDiscountAmount?: number | null | undefined;
  startsAt: string;
  expiresAt?: string | null | undefined;
  status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' | undefined;
  usageLimitTotal?: number | null | undefined;
  usageLimitPerCustomer?: number | null | undefined;
  firstOrderOnly?: boolean | undefined;
  stackable?: boolean | undefined;
}

export interface PromotionAnalyticsDto {
  totalRedemptions: number;
  totalDiscountAmount: number;
  promotionAttributedSales: number;
  promotions: Array<{
    promotionId: string;
    couponCode: string | null;
    redemptionCount: number;
    discountAmount: number;
  }>;
}

export const promotionsApi = {
  listPromotions: async (
    params?:
      | {
          merchantTenantId?: string | undefined;
          status?: string | undefined;
          limit?: number | undefined;
          offset?: number | undefined;
        }
      | undefined,
  ): Promise<PromotionDto[]> => {
    const query = new URLSearchParams();
    if (params?.merchantTenantId) query.set('merchantTenantId', params.merchantTenantId);
    if (params?.status) query.set('status', params.status);
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    const qs = query.toString() ? `?${query.toString()}` : '';
    return apiClient<PromotionDto[]>(`/promotions${qs}`);
  },

  getPromotion: async (id: string): Promise<PromotionDto> => {
    return apiClient<PromotionDto>(`/promotions/${id}`);
  },

  createPromotion: async (data: CreatePromotionPayload): Promise<PromotionDto> => {
    return apiClient<PromotionDto>('/promotions', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  updatePromotion: async (
    id: string,
    data: Partial<CreatePromotionPayload>,
  ): Promise<PromotionDto> => {
    return apiClient<PromotionDto>(`/promotions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  getPromotionAnalytics: async (merchantId?: string): Promise<PromotionAnalyticsDto> => {
    const qs = merchantId ? `?merchantId=${encodeURIComponent(merchantId)}` : '';
    return apiClient<PromotionAnalyticsDto>(`/analytics/promotions${qs}`);
  },
};
