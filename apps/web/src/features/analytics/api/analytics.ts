import { apiClient } from '../../../api/client';

export interface SalesTotalsDto {
  totalOrders: number;
  grossSales: string;
  netSales: string;
  refundAmount: string;
  averageOrderValue: string;
  unitsSold: number;
}

export interface SalesTrendPointDto {
  date: string;
  orders: number;
  grossSales: string;
  netSales: string;
  unitsSold: number;
  refundAmount: string;
}

export interface SalesAnalyticsDto {
  currency: string;
  totals: SalesTotalsDto;
  trends: SalesTrendPointDto[];
  breakdowns?: { ordersByStatus?: Record<string, number> };
}

export interface ProductAnalyticsItemDto {
  productId: string;
  title: string | null;
  category?: string | null;
  totalUnitsSold?: number;
  unitsSold?: number;
  totalRevenueAmount?: number | string;
  revenue?: number | string;
  orderCount?: number;
  refundCount?: number;
}

export interface OperationsAnalyticsDto {
  paymentSuccessCount: number;
  paymentFailCount: number;
  paymentSuccessRate: string;
  paymentFailureRate: string;
  shipmentCount: number;
  returnCount: number;
}

export interface OperationsResponseDto {
  currency: string;
  operations: OperationsAnalyticsDto;
}

export interface MlModelDto {
  id: string;
  tenantId: string;
  modelType: string;
  version: string;
  status: 'APPROVED' | 'CANDIDATE' | 'RETIRED' | 'REJECTED';
  accuracy?: number;
  rmse?: number;
  algorithm?: string;
  dataSourceType?: 'REAL' | 'BOOTSTRAP';
  isSynthetic?: boolean;
  createdAt: string;
}

export type MlModelType = 'DEMAND_FORECASTING' | 'STOCKOUT_RISK' | 'PURCHASE_PROPENSITY' | 'ANOMALY_DETECTION';

export interface MlTrainingJobDto {
  id: string;
  tenantId: string;
  modelType: string;
  triggerType: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  dataSourceType: 'REAL' | 'BOOTSTRAP';
  sampleCount: number;
  modelId?: string | null;
  errorMessage?: string | null;
  startedAt: string;
  completedAt?: string | null;
}

export interface MlPredictionDto {
  tenantId: string;
  modelType: string;
  modelVersion: string;
  entityType: 'PRODUCT' | 'SKU' | 'CUSTOMER';
  entityId: string;
  predictedValue: number;
  probability?: number | null;
  confidence?: number | null;
  horizon: string;
  dataSourceType: 'REAL' | 'BOOTSTRAP';
  isSynthetic: boolean;
  predictedAt: string;
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

export interface RetrainingPolicyDto {
  id: string;
  tenantId: string;
  modelType: MlModelType;
  minNewOrdersThreshold: number;
  lastTrainedOrderCount: number;
  lastTrainedAt?: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TrainingJobHistoryDto {
  id: string;
  tenantId: string;
  modelType: string;
  triggerType: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  dataSourceType: 'REAL' | 'BOOTSTRAP';
  sampleCount: number;
  modelId?: string | null;
  errorMessage?: string | null;
  startedAt: string;
  completedAt?: string | null;
}

export const analyticsApi = {
  getSalesAnalytics: async (granularity: 'day' | 'week' | 'month' = 'day'): Promise<SalesAnalyticsDto> => {
    return apiClient<SalesAnalyticsDto>(`/analytics/sales?granularity=${granularity}`);
  },

  getProductAnalytics: async (limit = 10): Promise<ProductAnalyticsItemDto[]> => {
    const res = await apiClient<{ products?: ProductAnalyticsItemDto[] }>(
      `/analytics/products?limit=${limit}`
    );
    return Array.isArray(res.products) ? res.products : [];
  },

  getOperationsAnalytics: async (): Promise<OperationsResponseDto> => {
    return apiClient<OperationsResponseDto>('/analytics/operations');
  },

  getMlModels: async (): Promise<{ models: MlModelDto[] }> => {
    return apiClient<{ models: MlModelDto[] }>('/ml/models');
  },

  rebuildAnalytics: async (): Promise<{
    status: string;
    sourceEventCount: number;
    factsRebuilt: number;
    aggregatesRebuilt: number;
  }> => {
    return apiClient('/analytics/rebuild', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  trainModel: async (modelType: MlModelType): Promise<{ jobId: string; status: string }> => {
    return apiClient<{ jobId: string; status: string }>('/ml/train', {
      method: 'POST',
      body: JSON.stringify({ modelType, triggerType: 'MANUAL' }),
    });
  },

  getTrainingJob: async (jobId: string): Promise<MlTrainingJobDto> => {
    return apiClient<MlTrainingJobDto>(`/ml/jobs/${jobId}`);
  },

  listPredictions: async (): Promise<{ predictions: MlPredictionDto[] }> => {
    return apiClient<{ predictions: MlPredictionDto[] }>('/ml/predictions');
  },

  getStockoutPrediction: async (sku: string): Promise<MlPredictionDto> => {
    return apiClient<MlPredictionDto>(`/ml/predictions/stockout/${sku}`);
  },

  getDemandPrediction: async (productId: string): Promise<MlPredictionDto> => {
    return apiClient<MlPredictionDto>(`/ml/predictions/demand/${productId}`);
  },

  // Training job history
  listTrainingJobs: async (modelType?: MlModelType): Promise<TrainingJobHistoryDto[]> => {
    const params = new URLSearchParams();
    if (modelType) params.append('modelType', modelType);
    const res = await apiClient<{ jobs: TrainingJobHistoryDto[] }>(`/ml/jobs?${params.toString()}`);
    return Array.isArray(res.jobs) ? res.jobs : [];
  },

  // Retraining policies
  getRetrainingPolicy: async (modelType: MlModelType): Promise<RetrainingPolicyDto | null> => {
    try {
      return await apiClient<RetrainingPolicyDto>(`/ml/policies/${modelType}`);
    } catch {
      return null;
    }
  },

  saveRetrainingPolicy: async (modelType: MlModelType, policy: Partial<RetrainingPolicyDto>): Promise<RetrainingPolicyDto> => {
    return apiClient<RetrainingPolicyDto>(`/ml/policies/${modelType}`, {
      method: 'PUT',
      body: JSON.stringify(policy),
    });
  },

  // Retrain trigger
  retrainModel: async (modelType: MlModelType): Promise<{ retrained: boolean; jobId?: string; reason: string }> => {
    return apiClient('/ml/retrain', {
      method: 'POST',
      body: JSON.stringify({ modelType }),
    });
  },

  // Rollback model
  rollbackModel: async (modelId: string): Promise<MlModelDto> => {
    return apiClient<MlModelDto>(`/ml/models/${modelId}/rollback`, { method: 'POST' });
  },
};
