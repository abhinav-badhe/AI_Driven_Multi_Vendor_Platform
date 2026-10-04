import { apiClient } from '../../../api/client';

export interface SalesAnalyticsDto {
  currency: string;
  totalOrders: number;
  grossSalesAmount: number;
  netSalesAmount: number;
  totalRefundAmount: number;
  averageOrderValue: number;
  timeline: Array<{
    period: string;
    ordersCount: number;
    grossSales: number;
    netSales: number;
  }>;
}

export interface ProductAnalyticsItemDto {
  productId: string;
  productTitle: string;
  categoryName?: string;
  totalUnitsSold: number;
  totalRevenueAmount: number;
  viewsCount: number;
  conversionRate: number;
}

export interface OperationsAnalyticsDto {
  totalPaymentsAttempted: number;
  paymentSuccessRate: number;
  totalShipmentsDispatched: number;
  totalReturnsRequested: number;
  returnRate: number;
  averageFulfillmentTimeHours: number;
}

export interface MlModelDto {
  id: string;
  tenantId: string;
  modelType: string;
  version: string;
  status: 'APPROVED' | 'CANDIDATE' | 'RETIRED' | 'REJECTED';
  accuracy?: number;
  rmse?: number;
  createdAt: string;
}

export interface MlPredictionDto {
  sku?: string;
  productId?: string;
  stockoutProbability?: number;
  predictedDemand?: number;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  horizonDays?: number;
  status?: string;
}

export const analyticsApi = {
  getSalesAnalytics: async (granularity: 'day' | 'week' | 'month' = 'day'): Promise<SalesAnalyticsDto> => {
    return apiClient<SalesAnalyticsDto>(`/analytics/sales?granularity=${granularity}`);
  },

  getProductAnalytics: async (limit = 10): Promise<ProductAnalyticsItemDto[]> => {
    return apiClient<ProductAnalyticsItemDto[]>(`/analytics/products?limit=${limit}`);
  },

  getOperationsAnalytics: async (): Promise<OperationsAnalyticsDto> => {
    return apiClient<OperationsAnalyticsDto>('/analytics/operations');
  },

  getMlModels: async (): Promise<{ models: MlModelDto[] }> => {
    return apiClient<{ models: MlModelDto[] }>('/ml/models');
  },

  getStockoutPrediction: async (sku: string): Promise<MlPredictionDto> => {
    return apiClient<MlPredictionDto>(`/ml/predictions/stockout/${sku}`);
  },

  getDemandPrediction: async (productId: string): Promise<MlPredictionDto> => {
    return apiClient<MlPredictionDto>(`/ml/predictions/demand/${productId}`);
  },
};
