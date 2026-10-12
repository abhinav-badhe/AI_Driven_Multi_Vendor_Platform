import { apiClient } from '../../../api/client';

export interface PromotionalBannerDto {
  id: string;
  title: string;
  subtitle?: string | null;
  badge_text?: string | null;
  image_url: string;
  target_url: string;
  display_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateBannerPayload {
  title: string;
  subtitle?: string | undefined;
  badgeText?: string | undefined;
  imageUrl: string;
  targetUrl?: string | undefined;
  displayOrder?: number | undefined;
  isActive?: boolean | undefined;
}

export const bannersApi = {
  // Public active banners for customer homepage
  getActiveBanners: async (): Promise<PromotionalBannerDto[]> => {
    const res = await apiClient<{ banners: PromotionalBannerDto[] }>('/banners');
    return res.banners || [];
  },

  // Admin list all banners
  getAllBanners: async (): Promise<PromotionalBannerDto[]> => {
    const res = await apiClient<{ banners: PromotionalBannerDto[] }>('/admin/banners');
    return res.banners || [];
  },

  // Admin create banner
  createBanner: async (payload: CreateBannerPayload): Promise<PromotionalBannerDto> => {
    return apiClient<PromotionalBannerDto>('/admin/banners', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // Admin update banner
  updateBanner: async (
    id: string,
    payload: Partial<CreateBannerPayload>,
  ): Promise<PromotionalBannerDto> => {
    return apiClient<PromotionalBannerDto>(`/admin/banners/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  // Admin delete banner
  deleteBanner: async (id: string): Promise<{ success: boolean }> => {
    return apiClient<{ success: boolean }>(`/admin/banners/${id}`, {
      method: 'DELETE',
    });
  },
};
