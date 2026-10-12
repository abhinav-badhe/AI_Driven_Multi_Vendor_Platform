import type {
  DerivedRecommendationRecord,
  IRecommendationStore,
  RecommendationType,
  RebuildRecommendationsResultDto,
} from './recommendation-models.js';
import type { Logger } from '../../../observability/logger.js';
import { ExternalServiceError } from '../../../errors/app-error.js';

export interface HttpRecommendationStoreOptions {
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  fallbackStore?: IRecommendationStore | undefined;
  logger?: Logger | undefined;
}

/**
 * HttpRecommendationStoreAdapter - Remote Recommendation Microservice HTTP Client.
 *
 * Implements IRecommendationStore to delegate recommendation retrieval, storage,
 * and cache invalidation to a dedicated recommendations microservice over HTTP.
 *
 * Resilience:
 * - Configurable request timeout via AbortController.
 * - Graceful fallback to local in-memory or SQL store on remote failure.
 */
export class HttpRecommendationStoreAdapter implements IRecommendationStore {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallbackStore?: IRecommendationStore | undefined;
  private readonly logger?: Logger | undefined;

  constructor(serviceUrl: string, options: HttpRecommendationStoreOptions = {}) {
    this.baseUrl = serviceUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.fallbackStore = options.fallbackStore;
    this.logger = options.logger;
  }

  getFallbackStore(): IRecommendationStore | undefined {
    return this.fallbackStore;
  }

  async saveRecommendations(records: DerivedRecommendationRecord[]): Promise<void> {
    try {
      await this.request('/v1/recommendations/store/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ records }),
      });
    } catch (err) {
      if (this.fallbackStore) {
        this.logger?.warn('HttpRecommendationStore: saveRecommendations failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          count: records.length,
        });
        await this.fallbackStore.saveRecommendations(records);
        return;
      }
      throw err;
    }
  }

  async getRecommendations(
    tenantId: string,
    type: RecommendationType,
    options?: {
      customerId?: string | null;
      sourceProductId?: string | null;
      limit?: number;
    },
  ): Promise<DerivedRecommendationRecord[]> {
    try {
      const res = await this.request<{ records: DerivedRecommendationRecord[] }>(
        '/v1/recommendations/store/query',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tenantId,
            type,
            customerId: options?.customerId ?? null,
            sourceProductId: options?.sourceProductId ?? null,
            limit: options?.limit ?? 10,
          }),
        },
      );
      return res.records ?? [];
    } catch (err) {
      if (this.fallbackStore) {
        this.logger?.warn('HttpRecommendationStore: getRecommendations failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          tenantId,
          type,
        });
        return this.fallbackStore.getRecommendations(tenantId, type, options);
      }
      throw err;
    }
  }

  async deleteByScope(
    tenantId: string,
    type: RecommendationType,
    customerId?: string | null,
    sourceProductId?: string | null,
  ): Promise<number> {
    try {
      const res = await this.request<{ deletedCount: number }>(
        '/v1/recommendations/store/delete-scope',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tenantId,
            type,
            customerId: customerId ?? null,
            sourceProductId: sourceProductId ?? null,
          }),
        },
      );
      return res.deletedCount ?? 0;
    } catch (err) {
      if (this.fallbackStore) {
        return this.fallbackStore.deleteByScope(tenantId, type, customerId, sourceProductId);
      }
      throw err;
    }
  }

  async clearTenantRecommendations(tenantId: string): Promise<number> {
    try {
      const res = await this.request<{ deletedCount: number }>(
        `/v1/recommendations/store/tenants/${encodeURIComponent(tenantId)}`,
        { method: 'DELETE' },
      );
      return res.deletedCount ?? 0;
    } catch (err) {
      if (this.fallbackStore) {
        return this.fallbackStore.clearTenantRecommendations(tenantId);
      }
      throw err;
    }
  }

  async invalidateProduct(tenantId: string, productId: string): Promise<number> {
    try {
      const res = await this.request<{ deletedCount: number }>(
        '/v1/recommendations/store/invalidate-product',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tenantId, productId }),
        },
      );
      return res.deletedCount ?? 0;
    } catch (err) {
      if (this.fallbackStore) {
        return this.fallbackStore.invalidateProduct(tenantId, productId);
      }
      throw err;
    }
  }

  async recordRebuildAudit(
    audit: Omit<RebuildRecommendationsResultDto, 'status'> & {
      id: string;
      status: 'COMPLETED' | 'FAILED';
    },
  ): Promise<void> {
    try {
      await this.request('/v1/recommendations/store/audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(audit),
      });
    } catch (err) {
      if (this.fallbackStore) {
        await this.fallbackStore.recordRebuildAudit(audit);
        return;
      }
      throw err;
    }
  }

  private async request<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorBody = '';
        try {
          errorBody = await response.text();
        } catch {
          // Ignore body read errors
        }
        throw new ExternalServiceError(
          `Recommendations service responded with HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
        );
      }

      if (response.status === 204) {
        return undefined as unknown as T;
      }

      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof ExternalServiceError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort') || message.includes('timeout')) {
        throw new ExternalServiceError(
          `Recommendations service request timed out after ${this.timeoutMs}ms: ${path}`,
        );
      }
      throw new ExternalServiceError(
        `Failed to communicate with recommendations service: ${message}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
