import { apiClient } from '../../../api/client';

export interface MerchantProfileDto {
  id: string;
  tenantId: string;
  businessName: string;
  legalName: string;
  contactEmail: string;
  verificationStatus: 'DRAFT' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';
  verifiedAt?: string | null;
}

export interface MerchantListingDto {
  id: string;
  tenantId: string;
  skuId: string;
  priceAmount: number;
  currency: string;
  compareAtPrice?: number | null;
  status: 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  createdAt: string;
  updatedAt: string;
}

// Enriched console view: product display content + stock levels included so
// sellers manage products, never raw IDs.
export interface MerchantListingDetailDto extends MerchantListingDto {
  skuCode: string;
  productId: string;
  productTitle: string;
  productSlug: string;
  brand?: string | null;
  thumbnailUrl?: string | null;
  images: string[];
  rating?: number | null;
  reviewCount: number;
  onHandQuantity: number | null;
  reservedQuantity: number | null;
  availableQuantity: number | null;
  inventoryVersion: number | null;
}

export interface InventoryItemDto {
  id: string;
  tenantId: string;
  listingId: string;
  skuId: string;
  onHandQuantity: number;
  reservedQuantity: number;
  nonSellableQuantity: number;
  availableQuantity?: number;
  version: number;
  updatedAt: string;
}

export interface SellerOrderDto {
  id: string;
  customerOrderId: string;
  sellerTenantId: string;
  status: 'PENDING_PAYMENT' | 'PAID' | 'PROCESSING' | 'COMPLETED' | 'CANCELLED';
  currency: string;
  subtotalAmount: number;
  totalAmount: number;
  createdAt: string;
  items?: Array<{
    id: string;
    productName: string;
    skuCode: string;
    quantity: number;
    unitPriceAmount: number;
    lineTotalAmount: number;
  }>;
}

export const merchantApi = {
  getProfile: async (): Promise<MerchantProfileDto> => {
    return apiClient<MerchantProfileDto>('/merchants/me');
  },

  getMyListings: async (): Promise<MerchantListingDto[]> => {
    return apiClient<MerchantListingDto[]>('/listings/me');
  },

  getMyListingDetails: async (): Promise<MerchantListingDetailDto[]> => {
    return apiClient<MerchantListingDetailDto[]>('/listings/me/detail');
  },

  getMyInventory: async (): Promise<InventoryItemDto[]> => {
    return apiClient<InventoryItemDto[]>('/inventory?limit=500');
  },

  adjustInventory: async (id: string, delta: number, reason: string): Promise<InventoryItemDto> => {
    if (delta >= 0) {
      return apiClient<InventoryItemDto>(`/inventory/${id}/increase-stock`, {
        method: 'POST',
        body: JSON.stringify({
          quantity: delta,
          notes: reason,
        }),
      });
    }
    return apiClient<InventoryItemDto>(`/inventory/${id}/decrease-stock`, {
      method: 'POST',
      body: JSON.stringify({
        quantity: Math.abs(delta),
        notes: reason,
      }),
    });
  },

  getSellerOrders: async (): Promise<SellerOrderDto[]> => {
    return apiClient<SellerOrderDto[]>('/seller/orders');
  },

  updateOrderStatus: async (orderId: string, status: string): Promise<SellerOrderDto> => {
    return apiClient<SellerOrderDto>(`/seller/orders/${orderId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  },

  getFinancialSummary: async (merchantId: string): Promise<FinancialSummaryDto> => {
    return apiClient<FinancialSummaryDto>(`/settlement/merchants/${merchantId}/summary`);
  },

  createListing: async (input: {
    skuId: string;
    priceAmount: number;
    currency: string;
    compareAtPrice?: number | null;
  }): Promise<MerchantListingDto> => {
    return apiClient<MerchantListingDto>('/listings', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  updateListingStatus: async (
    listingId: string,
    status: 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'SUSPENDED',
  ): Promise<MerchantListingDto> => {
    return apiClient<MerchantListingDto>(`/listings/${listingId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
  },

  updateListingPrice: async (
    listingId: string,
    input: { priceAmount?: number; compareAtPrice?: number | null },
  ): Promise<MerchantListingDto> => {
    return apiClient<MerchantListingDto>(`/listings/${listingId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  initInventory: async (input: {
    listingId: string;
    initialOnHandQuantity: number;
  }): Promise<InventoryItemDto> => {
    return apiClient<InventoryItemDto>('/inventory', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  getCatalogProducts: async (): Promise<
    Array<{ id: string; title: string; brand?: string; categoryId?: string }>
  > => {
    return apiClient<Array<{ id: string; title: string; brand?: string; categoryId?: string }>>(
      '/products',
    );
  },

  getCategories: async (): Promise<Array<{ id: string; name: string }>> => {
    return apiClient<Array<{ id: string; name: string }>>('/categories');
  },

  getProductSkus: async (
    productId: string,
  ): Promise<Array<{ id: string; skuCode: string; attributes?: Record<string, unknown> }>> => {
    return apiClient<Array<{ id: string; skuCode: string; attributes?: Record<string, unknown> }>>(
      `/products/${productId}/skus`,
    );
  },

  createProduct: async (input: {
    title: string;
    slug: string;
    description?: string;
    brand?: string;
    categoryId?: string;
    thumbnailUrl?: string;
    images?: string[];
    attributes?: Record<string, unknown>;
  }): Promise<{ id: string; title: string }> => {
    return apiClient<{ id: string; title: string }>('/products', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  createSku: async (
    productId: string,
    input: { skuCode: string; barcode?: string; attributes?: Record<string, unknown> },
  ): Promise<{ id: string; skuCode: string }> => {
    return apiClient<{ id: string; skuCode: string }>(`/products/${productId}/skus`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  updateSkuStatus: async (
    skuId: string,
    status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED',
  ): Promise<{ id: string; status: string }> => {
    return apiClient<{ id: string; status: string }>(`/skus/${skuId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
  },

  updateProductStatus: async (
    productId: string,
    status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED',
  ): Promise<{ id: string; status: string }> => {
    return apiClient<{ id: string; status: string }>(`/products/${productId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
  },
};

export interface FinancialSummaryDto {
  tenantId: string;
  currency: string;
  currentBalance: number;
  pendingBalance: number;
  settledBalance: number;
  totalEarnings: number;
  totalCommissions: number;
  totalFees: number;
  totalRefunds: number;
  totalAdjustments: number;
  ledgerCount: number;
}
