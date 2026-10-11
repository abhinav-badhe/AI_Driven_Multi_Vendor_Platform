import type {
  ISearchStore,
  SearchStoreQueryResult,
} from './search-store.js';
import type {
  SearchProductDocument,
  SearchQueryParams,
  SearchFacets,
} from './search-models.js';
import type { Logger } from '../../../observability/logger.js';
import { ExternalServiceError } from '../../../errors/app-error.js';

export interface HttpSearchStoreOptions {
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  fallbackStore?: ISearchStore | undefined;
  logger?: Logger | undefined;
}

/**
 * HttpSearchStoreAdapter - Decoupled HTTP Client for Remote Search Microservice.
 *
 * Implements ISearchStore to allow the monolith to delegate faceted queries,
 * projections, and search indexing to a dedicated search microservice over HTTP.
 *
 * Resilience:
 * - Configurable request timeout via AbortController.
 * - Graceful fallback to local in-memory or database search store on remote failure.
 */
export class HttpSearchStoreAdapter implements ISearchStore {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallbackStore?: ISearchStore | undefined;
  private readonly logger?: Logger | undefined;

  constructor(serviceUrl: string, options: HttpSearchStoreOptions = {}) {
    this.baseUrl = serviceUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.fallbackStore = options.fallbackStore;
    this.logger = options.logger;
  }

  getFallbackStore(): ISearchStore | undefined {
    return this.fallbackStore;
  }

  async indexDocument(doc: SearchProductDocument): Promise<void> {
    try {
      await this.request('/v1/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(doc),
      });
    } catch (err) {
      if (this.fallbackStore) {
        this.logger?.warn('HttpSearchStore: indexDocument failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          productId: doc.id,
        });
        await this.fallbackStore.indexDocument(doc);
        return;
      }
      throw err;
    }
  }

  async bulkIndex(docs: SearchProductDocument[]): Promise<void> {
    try {
      await this.request('/v1/documents/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documents: docs }),
      });
    } catch (err) {
      if (this.fallbackStore) {
        this.logger?.warn('HttpSearchStore: bulkIndex failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          count: docs.length,
        });
        await this.fallbackStore.bulkIndex(docs);
        return;
      }
      throw err;
    }
  }

  async replaceProjection(docs: SearchProductDocument[]): Promise<void> {
    try {
      await this.request('/v1/documents/replace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documents: docs }),
      });
    } catch (err) {
      if (this.fallbackStore) {
        this.logger?.warn('HttpSearchStore: replaceProjection failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          count: docs.length,
        });
        await this.fallbackStore.replaceProjection(docs);
        return;
      }
      throw err;
    }
  }

  async getDocument(id: string): Promise<SearchProductDocument | null> {
    try {
      const res = await this.request<SearchProductDocument | null>(
        `/v1/documents/${encodeURIComponent(id)}`,
        { method: 'GET' },
        true, // allow404
      );
      return res;
    } catch (err) {
      if (this.fallbackStore) {
        this.logger?.warn('HttpSearchStore: getDocument failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          id,
        });
        return this.fallbackStore.getDocument(id);
      }
      throw err;
    }
  }

  async deleteDocument(id: string): Promise<boolean> {
    try {
      const res = await this.request<{ deleted: boolean }>(
        `/v1/documents/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      return res?.deleted ?? true;
    } catch (err) {
      if (this.fallbackStore) {
        this.logger?.warn('HttpSearchStore: deleteDocument failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          id,
        });
        return this.fallbackStore.deleteDocument(id);
      }
      throw err;
    }
  }

  async search(params: SearchQueryParams): Promise<SearchStoreQueryResult> {
    try {
      const raw = await this.request<{
        items: SearchProductDocument[];
        scores?: Record<string, number> | [string, number][] | undefined;
        total: number;
        facets: SearchFacets;
      }>('/v1/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      });

      const scoresMap = new Map<string, number>();
      if (raw.scores) {
        if (Array.isArray(raw.scores)) {
          for (const [id, score] of raw.scores) {
            scoresMap.set(id, score);
          }
        } else {
          for (const [id, score] of Object.entries(raw.scores)) {
            scoresMap.set(id, score);
          }
        }
      }

      return {
        items: raw.items ?? [],
        scores: scoresMap,
        total: raw.total ?? (raw.items ? raw.items.length : 0),
        facets: raw.facets ?? {
          categories: [],
          brands: [],
          priceRange: { min: 0, max: 0 },
          attributes: {},
        },
      };
    } catch (err) {
      if (this.fallbackStore) {
        this.logger?.warn('HttpSearchStore: search failed, falling back to local store', {
          error: err instanceof Error ? err.message : 'unknown',
          query: params.q,
        });
        return this.fallbackStore.search(params);
      }
      throw err;
    }
  }

  async clear(): Promise<void> {
    try {
      await this.request('/v1/documents', { method: 'DELETE' });
    } catch (err) {
      if (this.fallbackStore) {
        await this.fallbackStore.clear();
        return;
      }
      throw err;
    }
  }

  async count(): Promise<number> {
    try {
      const res = await this.request<{ count: number }>('/v1/documents/count', {
        method: 'GET',
      });
      return res.count;
    } catch (err) {
      if (this.fallbackStore) {
        return this.fallbackStore.count();
      }
      throw err;
    }
  }

  async healthCheck(): Promise<{ status: string; count: number; engine: string }> {
    try {
      return await this.request<{ status: string; count: number; engine: string }>('/health', {
        method: 'GET',
      });
    } catch (err) {
      if (this.fallbackStore) {
        const fallbackHealth = await this.fallbackStore.healthCheck();
        return {
          status: 'degraded',
          count: fallbackHealth.count,
          engine: `http-fallback(${fallbackHealth.engine})`,
        };
      }
      return {
        status: 'unhealthy',
        count: 0,
        engine: 'http',
      };
    }
  }

  async findProductIdByListingId(listingId: string): Promise<string | null> {
    try {
      const res = await this.request<{ productId: string | null }>(
        `/v1/listings/${encodeURIComponent(listingId)}/product-id`,
        { method: 'GET' },
        true, // allow404
      );
      return res?.productId ?? null;
    } catch (err) {
      if (this.fallbackStore?.findProductIdByListingId) {
        return this.fallbackStore.findProductIdByListingId(listingId);
      }
      throw err;
    }
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit,
    allow404 = false,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });

      if (allow404 && response.status === 404) {
        return null as unknown as T;
      }

      if (!response.ok) {
        let errorBody = '';
        try {
          errorBody = await response.text();
        } catch {
          // Ignore body read errors
        }
        throw new ExternalServiceError(
          `Search service responded with HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
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
          `Search service request timed out after ${this.timeoutMs}ms: ${path}`,
        );
      }
      throw new ExternalServiceError(`Failed to communicate with search service: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
