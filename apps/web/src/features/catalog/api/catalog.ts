import { apiClient } from '../../../api/client';

export type Category = {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProductStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

export type Product = {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  brand: string | null;
  categoryId: string | null;
  status: ProductStatus;
  thumbnailUrl?: string | null;
  images?: string[];
  rating?: number | null;
  reviewCount?: number;
  attributes?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export type ProductReview = {
  id: string;
  productId: string;
  customerId?: string | null;
  rating: number;
  title?: string | null;
  comment?: string | null;
  reviewerName?: string | null;
  reviewerEmail?: string | null;
  status?: ReviewStatus;
  verifiedPurchase?: boolean;
  moderationNote?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
  updatedAt?: string;
};

export type ProductRatingSummary = {
  productId: string;
  averageRating: number;
  totalReviews: number;
  distribution: {
    5: number;
    4: number;
    3: number;
    2: number;
    1: number;
  };
};

export type ReviewEligibility = {
  hasPurchased: boolean;
  alreadyReviewed: boolean;
  isEligible: boolean;
  existingReviewId?: string;
};

export type SkuStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

export type Sku = {
  id: string;
  productId: string;
  skuCode: string;
  barcode: string | null;
  attributes: Record<string, unknown> | null;
  status: SkuStatus;
  createdAt: string;
  updatedAt: string;
};

export const catalogApi = {
  getCategories: async (): Promise<Category[]> => {
    return apiClient<Category[]>('/categories');
  },
  getCategory: async (id: string): Promise<Category> => {
    return apiClient<Category>(`/categories/${id}`);
  },
  getProducts: async (params?: { categoryId?: string; status?: ProductStatus; search?: string; limit?: number; offset?: number }): Promise<Product[]> => {
    const query = new URLSearchParams();
    if (params?.categoryId) query.append('categoryId', params.categoryId);
    if (params?.status) query.append('status', params.status);
    if (params?.search) query.append('search', params.search);
    if (params?.limit) query.append('limit', params.limit.toString());
    if (params?.offset) query.append('offset', params.offset.toString());
    const qs = query.toString();
    return apiClient<Product[]>(`/products${qs ? `?${qs}` : ''}`);
  },
  getProduct: async (id: string): Promise<Product> => {
    return apiClient<Product>(`/products/${id}`);
  },
  getProductReviews: async (productId: string): Promise<ProductReview[]> => {
    return apiClient<ProductReview[]>(`/api/v1/products/${productId}/reviews`);
  },
  getProductRatingSummary: async (productId: string): Promise<ProductRatingSummary> => {
    return apiClient<ProductRatingSummary>(`/api/v1/products/${productId}/rating-summary`);
  },
  getReviewEligibility: async (productId: string): Promise<ReviewEligibility> => {
    return apiClient<ReviewEligibility>(`/api/v1/products/${productId}/review-eligibility`);
  },
  submitReview: async (
    productId: string,
    data: { rating: number; title?: string | undefined; comment: string },
  ): Promise<ProductReview> => {
    return apiClient<ProductReview>(`/api/v1/products/${productId}/reviews`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  updateReview: async (
    reviewId: string,
    data: { rating?: number | undefined; title?: string | undefined; comment?: string | undefined },
  ): Promise<ProductReview> => {
    return apiClient<ProductReview>(`/api/v1/reviews/${reviewId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },
  deleteReview: async (reviewId: string): Promise<void> => {
    return apiClient<void>(`/api/v1/reviews/${reviewId}`, {
      method: 'DELETE',
    });
  },
  getCustomerReviews: async (): Promise<ProductReview[]> => {
    return apiClient<ProductReview[]>('/api/v1/customer/reviews');
  },
  recordView: async (
    productId: string,
    input?: { priceSeenMinor?: number; currency?: string },
  ): Promise<{ tracked: boolean }> => {
    return apiClient<{ tracked: boolean }>(`/products/${productId}/views`, {
      method: 'POST',
      body: JSON.stringify(input ?? {}),
    });
  },
  getProductSkus: async (productId: string): Promise<Sku[]> => {
    return apiClient<Sku[]>(`/products/${productId}/skus`);
  },
  getSku: async (id: string): Promise<Sku> => {
    return apiClient<Sku>(`/skus/${id}`);
  }
};
