import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type {
  ICatalogService,
  CategoryDto,
  ProductDto,
  ProductReviewDto,
  ProductSkuDto,
  CreateCategoryInput,
  CreateProductInput,
  UpdateProductInput,
  CreateSkuInput,
  UpdateSkuInput,
  ProductStatus,
  SkuStatus,
  ListProductsFilter,
} from './catalog-models.js';
import type { Logger } from '../../../observability/logger.js';
import {
  ExternalServiceError,
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';

export interface HttpCatalogClientOptions {
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  fallbackService?: ICatalogService | undefined;
  logger?: Logger | undefined;
}

/**
 * HttpCatalogClient - Remote Catalog Microservice HTTP Client.
 *
 * Implements ICatalogService to delegate product catalog, category, and SKU management
 * to a standalone catalog-service microservice over HTTP.
 *
 * Resilience:
 * - Configurable request timeout via AbortController.
 * - Propagates identity context (x-user-id, x-tenant-id, x-user-role) for cross-service authorization.
 * - Graceful fallback to local SQL/in-memory CatalogService on network or 5xx server failure.
 */
export class HttpCatalogClient implements ICatalogService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallbackService?: ICatalogService | undefined;
  private readonly logger?: Logger | undefined;

  constructor(serviceUrl: string, options: HttpCatalogClientOptions = {}) {
    this.baseUrl = serviceUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.fallbackService = options.fallbackService;
    this.logger = options.logger;
  }

  getFallbackService(): ICatalogService | undefined {
    return this.fallbackService;
  }

  // --- Category Operations ---

  async createCategory(actor: AuthorizedActor, input: CreateCategoryInput): Promise<CategoryDto> {
    try {
      return await this.request<CategoryDto>('/categories', 'POST', input, actor);
    } catch (err) {
      if (
        err instanceof ValidationError ||
        err instanceof ForbiddenError ||
        err instanceof ConflictError ||
        err instanceof NotFoundError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpCatalogClient: createCategory failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
        });
        return this.fallbackService.createCategory(actor, input);
      }
      throw err;
    }
  }

  async listCategories(): Promise<CategoryDto[]> {
    try {
      return await this.request<CategoryDto[]>('/categories', 'GET');
    } catch (err) {
      if (this.fallbackService) {
        this.logger?.warn('HttpCatalogClient: listCategories failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
        });
        return this.fallbackService.listCategories();
      }
      throw err;
    }
  }

  async getCategoryById(id: string): Promise<CategoryDto> {
    try {
      return await this.request<CategoryDto>(`/categories/${encodeURIComponent(id)}`, 'GET');
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpCatalogClient: getCategoryById failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          id,
        });
        return this.fallbackService.getCategoryById(id);
      }
      throw err;
    }
  }

  // --- Product Operations ---

  async createProduct(actor: AuthorizedActor, input: CreateProductInput): Promise<ProductDto> {
    try {
      return await this.request<ProductDto>('/products', 'POST', input, actor);
    } catch (err) {
      if (
        err instanceof ValidationError ||
        err instanceof ForbiddenError ||
        err instanceof ConflictError ||
        err instanceof NotFoundError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpCatalogClient: createProduct failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
        });
        return this.fallbackService.createProduct(actor, input);
      }
      throw err;
    }
  }

  async getProductById(id: string): Promise<ProductDto> {
    try {
      return await this.request<ProductDto>(`/products/${encodeURIComponent(id)}`, 'GET');
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpCatalogClient: getProductById failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          id,
        });
        return this.fallbackService.getProductById(id);
      }
      throw err;
    }
  }

  async updateProduct(
    actor: AuthorizedActor,
    id: string,
    updates: UpdateProductInput,
  ): Promise<ProductDto> {
    try {
      return await this.request<ProductDto>(
        `/products/${encodeURIComponent(id)}`,
        'PATCH',
        updates,
        actor,
      );
    } catch (err) {
      if (
        err instanceof ValidationError ||
        err instanceof ForbiddenError ||
        err instanceof ConflictError ||
        err instanceof NotFoundError ||
        err instanceof InvalidStateTransitionError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpCatalogClient: updateProduct failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          id,
        });
        return this.fallbackService.updateProduct(actor, id, updates);
      }
      throw err;
    }
  }

  async setProductStatus(
    actor: AuthorizedActor,
    id: string,
    newStatus: ProductStatus,
  ): Promise<ProductDto> {
    try {
      return await this.request<ProductDto>(
        `/products/${encodeURIComponent(id)}/status`,
        'PATCH',
        { status: newStatus },
        actor,
      );
    } catch (err) {
      if (
        err instanceof ValidationError ||
        err instanceof ForbiddenError ||
        err instanceof NotFoundError ||
        err instanceof InvalidStateTransitionError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpCatalogClient: setProductStatus failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          id,
        });
        return this.fallbackService.setProductStatus(actor, id, newStatus);
      }
      throw err;
    }
  }

  async listProducts(filter?: ListProductsFilter): Promise<ProductDto[]> {
    try {
      const query = new URLSearchParams();
      if (filter?.status) query.set('status', filter.status);
      if (filter?.categoryId) query.set('categoryId', filter.categoryId);
      if (filter?.brand) query.set('brand', filter.brand);
      if (filter?.search) query.set('search', filter.search);
      if (filter?.limit) query.set('limit', String(filter.limit));
      if (filter?.offset) query.set('offset', String(filter.offset));

      const qs = query.toString();
      const path = qs ? `/products?${qs}` : '/products';
      return await this.request<ProductDto[]>(path, 'GET');
    } catch (err) {
      if (this.fallbackService) {
        this.logger?.warn('HttpCatalogClient: listProducts failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
        });
        return this.fallbackService.listProducts(filter);
      }
      throw err;
    }
  }

  async listProductReviews(productId: string): Promise<ProductReviewDto[]> {
    try {
      return await this.request<ProductReviewDto[]>(
        `/products/${encodeURIComponent(productId)}/reviews`,
        'GET',
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpCatalogClient: listProductReviews failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          productId,
        });
        return this.fallbackService.listProductReviews(productId);
      }
      throw err;
    }
  }

  // --- SKU Operations ---

  async createSku(
    actor: AuthorizedActor,
    productId: string,
    input: CreateSkuInput,
  ): Promise<ProductSkuDto> {
    try {
      return await this.request<ProductSkuDto>(
        `/products/${encodeURIComponent(productId)}/skus`,
        'POST',
        input,
        actor,
      );
    } catch (err) {
      if (
        err instanceof ValidationError ||
        err instanceof ForbiddenError ||
        err instanceof ConflictError ||
        err instanceof NotFoundError ||
        err instanceof InvalidStateTransitionError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpCatalogClient: createSku failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          productId,
        });
        return this.fallbackService.createSku(actor, productId, input);
      }
      throw err;
    }
  }

  async getSkuById(id: string): Promise<ProductSkuDto> {
    try {
      return await this.request<ProductSkuDto>(`/skus/${encodeURIComponent(id)}`, 'GET');
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpCatalogClient: getSkuById failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          id,
        });
        return this.fallbackService.getSkuById(id);
      }
      throw err;
    }
  }

  async listSkusByProduct(
    productId: string,
    actor?: AuthorizedActor | null,
  ): Promise<ProductSkuDto[]> {
    try {
      return await this.request<ProductSkuDto[]>(
        `/products/${encodeURIComponent(productId)}/skus`,
        'GET',
        undefined,
        actor ?? undefined,
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpCatalogClient: listSkusByProduct failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          productId,
        });
        return this.fallbackService.listSkusByProduct(productId, actor);
      }
      throw err;
    }
  }

  async updateSku(
    actor: AuthorizedActor,
    id: string,
    updates: UpdateSkuInput,
  ): Promise<ProductSkuDto> {
    try {
      return await this.request<ProductSkuDto>(
        `/skus/${encodeURIComponent(id)}`,
        'PATCH',
        updates,
        actor,
      );
    } catch (err) {
      if (
        err instanceof ValidationError ||
        err instanceof ForbiddenError ||
        err instanceof ConflictError ||
        err instanceof NotFoundError ||
        err instanceof InvalidStateTransitionError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpCatalogClient: updateSku failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          id,
        });
        return this.fallbackService.updateSku(actor, id, updates);
      }
      throw err;
    }
  }

  async setSkuStatus(
    actor: AuthorizedActor,
    id: string,
    newStatus: SkuStatus,
  ): Promise<ProductSkuDto> {
    try {
      return await this.request<ProductSkuDto>(
        `/skus/${encodeURIComponent(id)}/status`,
        'PATCH',
        { status: newStatus },
        actor,
      );
    } catch (err) {
      if (
        err instanceof ValidationError ||
        err instanceof ForbiddenError ||
        err instanceof NotFoundError ||
        err instanceof InvalidStateTransitionError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpCatalogClient: setSkuStatus failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          id,
        });
        return this.fallbackService.setSkuStatus(actor, id, newStatus);
      }
      throw err;
    }
  }

  // --- Internal HTTP transport ---

  private async request<T = unknown>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
    actor?: AuthorizedActor,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      accept: 'application/json',
    };

    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    if (actor) {
      headers['x-user-id'] = actor.userId;
      headers['x-tenant-id'] = actor.tenantId;
      headers['x-user-role'] = actor.role;
    }

    const requestInit: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };
    if (body !== undefined) {
      requestInit.body = JSON.stringify(body);
    }

    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, requestInit);

      if (response.status === 404) {
        throw new NotFoundError(`Resource not found at ${path}`);
      }
      if (response.status === 400) {
        let msg = 'Bad request';
        try {
          const json = (await response.json()) as { message?: string };
          if (json.message) msg = json.message;
        } catch {
          // ignore
        }
        throw new ValidationError(msg);
      }
      if (response.status === 403) {
        let msg = 'Forbidden';
        try {
          const json = (await response.json()) as { message?: string };
          if (json.message) msg = json.message;
        } catch {
          // ignore
        }
        throw new ForbiddenError(msg);
      }
      if (response.status === 409) {
        let msg = 'Conflict';
        try {
          const json = (await response.json()) as { message?: string };
          if (json.message) msg = json.message;
        } catch {
          // ignore
        }
        throw new ConflictError(msg);
      }
      if (response.status === 422) {
        let msg = 'Invalid state transition';
        try {
          const json = (await response.json()) as { message?: string };
          if (json.message) msg = json.message;
        } catch {
          // ignore
        }
        throw new InvalidStateTransitionError(msg);
      }

      if (!response.ok) {
        let errorBody = '';
        try {
          errorBody = await response.text();
        } catch {
          // ignore
        }
        throw new ExternalServiceError(
          `Catalog service responded with HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
        );
      }

      return (await response.json()) as T;
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof ValidationError ||
        err instanceof ForbiddenError ||
        err instanceof ConflictError ||
        err instanceof InvalidStateTransitionError ||
        err instanceof ExternalServiceError
      ) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort') || message.includes('timeout')) {
        throw new ExternalServiceError(
          `Catalog service request timed out after ${this.timeoutMs}ms: ${path}`,
        );
      }
      throw new ExternalServiceError(`Failed to communicate with catalog service: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
