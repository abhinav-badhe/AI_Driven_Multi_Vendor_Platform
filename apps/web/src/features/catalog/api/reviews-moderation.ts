import { apiClient } from '../../../api/client';

export interface ModerationReviewDto {
  id: string;
  productId: string;
  customerId: string;
  rating: number;
  headline: string | null;
  content: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  moderationNote: string | null;
  createdAt: string;
}

export const adminReviewsApi = {
  listReviews: async (params?: { status?: string; productId?: string }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.productId) qs.set('productId', params.productId);
    const qStr = qs.toString();
    return apiClient<ModerationReviewDto[]>(`/admin/reviews${qStr ? `?${qStr}` : ''}`);
  },
  approve: async (id: string, note?: string) => {
    return apiClient<ModerationReviewDto>(`/admin/reviews/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
  },
  reject: async (id: string, note?: string) => {
    return apiClient<ModerationReviewDto>(`/admin/reviews/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
  },
};

export const merchantReviewsApi = {
  listReviews: async (params?: { status?: string; productId?: string }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.productId) qs.set('productId', params.productId);
    const qStr = qs.toString();
    return apiClient<ModerationReviewDto[]>(`/merchant/reviews${qStr ? `?${qStr}` : ''}`);
  },
  approve: async (id: string, note?: string) => {
    return apiClient<ModerationReviewDto>(`/merchant/reviews/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
  },
  reject: async (id: string, note?: string) => {
    return apiClient<ModerationReviewDto>(`/merchant/reviews/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
  },
};
