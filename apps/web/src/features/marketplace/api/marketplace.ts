import { apiClient } from '../../../api/client';

export type ListingStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'SUSPENDED';

export type Listing = {
  id: string;
  tenantId: string;
  skuId: string;
  priceAmount: number;
  currency: string;
  compareAtPrice: number | null;
  status: ListingStatus;
  createdAt: string;
  updatedAt: string;
};

export const marketplaceApi = {
  getSkuListings: async (skuId: string): Promise<Listing[]> => {
    return apiClient<Listing[]>(`/skus/${skuId}/listings`);
  }
};
