import { apiClient } from '../../../api/client';

export interface PriceAlertDto {
  id: string;
  customerId: string;
  tenantId: string;
  productId: string;
  productTitle: string;
  productBrand: string | null;
  productThumbnailUrl: string | null;
  targetPriceMinor: number | null;
  currency: string | null;
  isActive: boolean;
  createdAt: string;
}

export const priceAlertsApi = {
  getMyAlerts: async () => {
    return apiClient<PriceAlertDto[]>('/price-alerts/mine');
  },
  
  unsubscribe: async (productId: string) => {
    return apiClient<{ success: boolean }>(`/price-alerts/watches/${productId}`, {
      method: 'DELETE',
    });
  },

  adminSweep: async (sinceDays: number = 90) => {
    return apiClient<{ success: boolean; triggeredCount: number }>('/price-alerts/sweep', {
      method: 'POST',
      body: JSON.stringify({ sinceDays }),
    });
  }
};
