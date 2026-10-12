import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type {
  IMarketplaceService,
  MerchantListingDto,
  MerchantListingDetailDto,
  CreateListingInput,
  UpdateListingInput,
  ListingStatus,
  ListListingsFilter,
} from './marketplace-models.js';
import type { Logger } from '../../../observability/logger.js';
import {
  ExternalServiceError,
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';

export interface HttpMarketplaceClientOptions {
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  fallbackService?: IMarketplaceService | undefined;
  logger?: Logger | undefined;
}

/**
 * HttpMarketplaceClient - Remote Marketplace & Listings Microservice HTTP Client.
 *
 * Implements IMarketplaceService to delegate marketplace listing management
 * to a standalone marketplace-service microservice over HTTP.
 *
 * Resilience:
 * - Configurable request timeout via AbortController.
 * - Propagates identity context (x-user-id, x-tenant-id, x-user-role) for cross-service authorization.
 * - Graceful fallback to local SQL/in-memory MarketplaceStore on network or 5xx server failure.
 */
export class HttpMarketplaceClient implements IMarketplaceService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallbackService?: IMarketplaceService | undefined;
  private readonly logger?: Logger | undefined;

  constructor(serviceUrl: string, options: HttpMarketplaceClientOptions = {}) {
    this.baseUrl = serviceUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.fallbackService = options.fallbackService;
    this.logger = options.logger;
  }

  getFallbackService(): IMarketplaceService | undefined {
    return this.fallbackService;
  }

  async createListing(
    actor: AuthorizedActor,
    input: CreateListingInput,
  ): Promise<MerchantListingDto> {
    try {
      return await this.request<MerchantListingDto>('/listings', 'POST', input, actor);
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
        this.logger?.warn('HttpMarketplaceClient: createListing failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
        });
        return this.fallbackService.createListing(actor, input);
      }
      throw err;
    }
  }

  async getMyListings(
    actor: AuthorizedActor,
    filter?: ListListingsFilter,
  ): Promise<MerchantListingDto[]> {
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    if (filter?.skuId) params.set('skuId', filter.skuId);
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter?.offset !== undefined) params.set('offset', String(filter.offset));
    const qs = params.toString() ? `?${params.toString()}` : '';

    try {
      return await this.request<MerchantListingDto[]>(`/listings/me${qs}`, 'GET', undefined, actor);
    } catch (err) {
      if (err instanceof ForbiddenError || err instanceof ValidationError) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpMarketplaceClient: getMyListings failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
        });
        return this.fallbackService.getMyListings(actor, filter);
      }
      throw err;
    }
  }

  async getMyListingDetails(actor: AuthorizedActor): Promise<MerchantListingDetailDto[]> {
    try {
      return await this.request<MerchantListingDetailDto[]>(
        '/listings/me/detail',
        'GET',
        undefined,
        actor,
      );
    } catch (err) {
      if (err instanceof ForbiddenError || err instanceof ValidationError) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpMarketplaceClient: getMyListingDetails failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
        });
        return this.fallbackService.getMyListingDetails(actor);
      }
      throw err;
    }
  }

  async getListingById(actor: AuthorizedActor | null, id: string): Promise<MerchantListingDto> {
    try {
      return await this.request<MerchantListingDto>(
        `/listings/${encodeURIComponent(id)}`,
        'GET',
        undefined,
        actor ?? undefined,
      );
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof ForbiddenError) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpMarketplaceClient: getListingById failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          id,
        });
        return this.fallbackService.getListingById(actor, id);
      }
      throw err;
    }
  }

  async updateListing(
    actor: AuthorizedActor,
    id: string,
    updates: UpdateListingInput,
  ): Promise<MerchantListingDto> {
    try {
      return await this.request<MerchantListingDto>(
        `/listings/${encodeURIComponent(id)}`,
        'PATCH',
        updates,
        actor,
      );
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof ForbiddenError ||
        err instanceof ValidationError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpMarketplaceClient: updateListing failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          id,
        });
        return this.fallbackService.updateListing(actor, id, updates);
      }
      throw err;
    }
  }

  async setListingStatus(
    actor: AuthorizedActor,
    id: string,
    newStatus: ListingStatus,
  ): Promise<MerchantListingDto> {
    try {
      return await this.request<MerchantListingDto>(
        `/listings/${encodeURIComponent(id)}/status`,
        'POST',
        { status: newStatus },
        actor,
      );
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof ForbiddenError ||
        err instanceof InvalidStateTransitionError ||
        err instanceof ValidationError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpMarketplaceClient: setListingStatus failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          id,
          newStatus,
        });
        return this.fallbackService.setListingStatus(actor, id, newStatus);
      }
      throw err;
    }
  }

  async getActiveListingsForSku(skuId: string): Promise<MerchantListingDto[]> {
    try {
      return await this.request<MerchantListingDto[]>(
        `/skus/${encodeURIComponent(skuId)}/listings`,
        'GET',
      );
    } catch (err) {
      if (this.fallbackService) {
        this.logger?.warn('HttpMarketplaceClient: getActiveListingsForSku failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          skuId,
        });
        return this.fallbackService.getActiveListingsForSku(skuId);
      }
      throw err;
    }
  }

  async listAllListings(
    actor: AuthorizedActor,
    filter?: ListListingsFilter,
  ): Promise<MerchantListingDto[]> {
    try {
      const q = new URLSearchParams();
      if (filter?.status) q.set('status', filter.status);
      if (filter?.limit != null) q.set('limit', String(filter.limit));
      if (filter?.offset != null) q.set('offset', String(filter.offset));
      const qs = q.toString() ? `?${q.toString()}` : '';
      return await this.request<MerchantListingDto[]>(
        `/admin/listings${qs}`,
        'GET',
        undefined,
        actor,
      );
    } catch (err) {
      if (this.fallbackService) {
        this.logger?.warn('HttpMarketplaceClient: listAllListings failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
        });
        return this.fallbackService.listAllListings(actor, filter);
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
          `Marketplace service responded with HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
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
          `Marketplace service request timed out after ${this.timeoutMs}ms: ${path}`,
        );
      }
      throw new ExternalServiceError(`Failed to communicate with marketplace service: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
