import type {
  IAnalyticsRecommendationReader,
  IAnalyticsMlFeatureReader,
  TrendingProductSignal,
  CustomerPurchaseHistorySignal,
  CoPurchaseSignal,
  ProductDailyDemandRecord,
  InventoryVelocitySignal,
  CustomerActivitySignal,
  OrderAnomalySignal,
} from './analytics-models.js';
import type { Logger } from '../../../observability/logger.js';
import { ExternalServiceError } from '../../../errors/app-error.js';

export interface HttpAnalyticsClientOptions {
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  fallbackReader?: (IAnalyticsRecommendationReader & IAnalyticsMlFeatureReader) | undefined;
  logger?: Logger | undefined;
}

/**
 * HttpAnalyticsClient - Remote Analytics Microservice HTTP Client.
 *
 * Implements IAnalyticsRecommendationReader and IAnalyticsMlFeatureReader
 * to fetch aggregated analytical signals from a dedicated analytics-service
 * microservice over HTTP.
 *
 * Resilience:
 * - Configurable request timeout via AbortController.
 * - Graceful fallback to local in-memory or SQL analytics reader on remote failure.
 */
export class HttpAnalyticsClient
  implements IAnalyticsRecommendationReader, IAnalyticsMlFeatureReader
{
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallbackReader?:
    (IAnalyticsRecommendationReader & IAnalyticsMlFeatureReader) | undefined;
  private readonly logger?: Logger | undefined;

  constructor(serviceUrl: string, options: HttpAnalyticsClientOptions = {}) {
    this.baseUrl = serviceUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.fallbackReader = options.fallbackReader;
    this.logger = options.logger;
  }

  getFallbackReader(): (IAnalyticsRecommendationReader & IAnalyticsMlFeatureReader) | undefined {
    return this.fallbackReader;
  }

  // --- IAnalyticsRecommendationReader ---

  async getTrendingProducts(tenantId: string, limit?: number): Promise<TrendingProductSignal[]> {
    const searchParams = new URLSearchParams({ tenantId });
    if (limit !== undefined) {
      searchParams.set('limit', String(limit));
    }

    try {
      const res = await this.request<{ items: TrendingProductSignal[] }>(
        `/v1/analytics/signals/trending?${searchParams.toString()}`,
      );
      return res.items ?? [];
    } catch (err) {
      if (this.fallbackReader) {
        this.logger?.warn('HttpAnalyticsClient: getTrendingProducts failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          tenantId,
        });
        return this.fallbackReader.getTrendingProducts(tenantId, limit);
      }
      throw err;
    }
  }

  async getCustomerPurchaseHistory(
    tenantId: string,
    customerId: string,
  ): Promise<CustomerPurchaseHistorySignal[]> {
    const searchParams = new URLSearchParams({ tenantId, customerId });

    try {
      const res = await this.request<{ items: CustomerPurchaseHistorySignal[] }>(
        `/v1/analytics/signals/customer-history?${searchParams.toString()}`,
      );
      return res.items ?? [];
    } catch (err) {
      if (this.fallbackReader) {
        this.logger?.warn('HttpAnalyticsClient: getCustomerPurchaseHistory failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          tenantId,
          customerId,
        });
        return this.fallbackReader.getCustomerPurchaseHistory(tenantId, customerId);
      }
      throw err;
    }
  }

  async getCoPurchasedProducts(
    tenantId: string,
    sourceProductId: string,
    limit?: number,
  ): Promise<CoPurchaseSignal[]> {
    const searchParams = new URLSearchParams({ tenantId, sourceProductId });
    if (limit !== undefined) {
      searchParams.set('limit', String(limit));
    }

    try {
      const res = await this.request<{ items: CoPurchaseSignal[] }>(
        `/v1/analytics/signals/co-purchased?${searchParams.toString()}`,
      );
      return res.items ?? [];
    } catch (err) {
      if (this.fallbackReader) {
        this.logger?.warn('HttpAnalyticsClient: getCoPurchasedProducts failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          tenantId,
          sourceProductId,
        });
        return this.fallbackReader.getCoPurchasedProducts(tenantId, sourceProductId, limit);
      }
      throw err;
    }
  }

  // --- IAnalyticsMlFeatureReader ---

  async getProductDailyDemandHistory(
    tenantId: string,
    lookbackDays?: number,
  ): Promise<ProductDailyDemandRecord[]> {
    const searchParams = new URLSearchParams({ tenantId });
    if (lookbackDays !== undefined) {
      searchParams.set('lookbackDays', String(lookbackDays));
    }

    try {
      const res = await this.request<{ items: ProductDailyDemandRecord[] }>(
        `/v1/analytics/signals/ml/demand-history?${searchParams.toString()}`,
      );
      return res.items ?? [];
    } catch (err) {
      if (this.fallbackReader) {
        this.logger?.warn(
          'HttpAnalyticsClient: getProductDailyDemandHistory failed, falling back',
          {
            error: err instanceof Error ? err.message : 'unknown',
            tenantId,
          },
        );
        return this.fallbackReader.getProductDailyDemandHistory(tenantId, lookbackDays);
      }
      throw err;
    }
  }

  async getInventoryVelocitySignals(tenantId: string): Promise<InventoryVelocitySignal[]> {
    const searchParams = new URLSearchParams({ tenantId });

    try {
      const res = await this.request<{ items: InventoryVelocitySignal[] }>(
        `/v1/analytics/signals/ml/inventory-velocity?${searchParams.toString()}`,
      );
      return res.items ?? [];
    } catch (err) {
      if (this.fallbackReader) {
        return this.fallbackReader.getInventoryVelocitySignals(tenantId);
      }
      throw err;
    }
  }

  async getCustomerActivitySignals(tenantId: string): Promise<CustomerActivitySignal[]> {
    const searchParams = new URLSearchParams({ tenantId });

    try {
      const res = await this.request<{ items: CustomerActivitySignal[] }>(
        `/v1/analytics/signals/ml/customer-activity?${searchParams.toString()}`,
      );
      return res.items ?? [];
    } catch (err) {
      if (this.fallbackReader) {
        return this.fallbackReader.getCustomerActivitySignals(tenantId);
      }
      throw err;
    }
  }

  async getOrderAnomalySignals(tenantId: string): Promise<OrderAnomalySignal[]> {
    const searchParams = new URLSearchParams({ tenantId });

    try {
      const res = await this.request<{ items: OrderAnomalySignal[] }>(
        `/v1/analytics/signals/ml/order-anomaly?${searchParams.toString()}`,
      );
      return res.items ?? [];
    } catch (err) {
      if (this.fallbackReader) {
        return this.fallbackReader.getOrderAnomalySignals(tenantId);
      }
      throw err;
    }
  }

  private async request<T = unknown>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorBody = '';
        try {
          errorBody = await response.text();
        } catch {
          // Ignore
        }
        throw new ExternalServiceError(
          `Analytics service responded with HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
        );
      }

      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof ExternalServiceError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort') || message.includes('timeout')) {
        throw new ExternalServiceError(
          `Analytics service request timed out after ${this.timeoutMs}ms: ${path}`,
        );
      }
      throw new ExternalServiceError(`Failed to communicate with analytics service: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
