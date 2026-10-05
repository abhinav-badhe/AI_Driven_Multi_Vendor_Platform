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

export type ProductReview = {
  id: string;
  productId: string;
  rating: number;
  comment?: string | null;
  reviewerName?: string | null;
  reviewerEmail?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
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
    return apiClient<ProductReview[]>(`/products/${productId}/reviews`);
  },
  getProductSkus: async (productId: string): Promise<Sku[]> => {
    return apiClient<Sku[]>(`/products/${productId}/skus`);
  },
  getSku: async (id: string): Promise<Sku> => {
    return apiClient<Sku>(`/skus/${id}`);
  }
};
