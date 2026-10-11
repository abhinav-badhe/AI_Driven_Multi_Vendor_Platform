import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type {
  MerchantProfileDto,
  OnboardMerchantInput,
  UpdateMerchantProfileInput,
  IMerchantService,
} from './merchant-models.js';
import type { Logger } from '../../../observability/logger.js';
import {
  ExternalServiceError,
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
} from '../../../errors/app-error.js';

export interface HttpMerchantClientOptions {
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  fallbackService?: IMerchantService | undefined;
  logger?: Logger | undefined;
}

/**
 * HttpMerchantClient - Remote Merchant Microservice HTTP Client.
 *
 * Implements IMerchantService to delegate merchant onboarding, verification,
 * and profile management to a standalone merchant-service microservice over HTTP.
 *
 * Resilience:
 * - Configurable request timeout via AbortController.
 * - Propagates identity context (x-user-id, x-tenant-id, x-user-role) for cross-service authorization.
 * - Graceful fallback to local SQL/in-memory MerchantService on network or 5xx server failure.
 */
export class HttpMerchantClient implements IMerchantService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallbackService?: IMerchantService | undefined;
  private readonly logger?: Logger | undefined;

  constructor(serviceUrl: string, options: HttpMerchantClientOptions = {}) {
    this.baseUrl = serviceUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.fallbackService = options.fallbackService;
    this.logger = options.logger;
  }

  getFallbackService(): IMerchantService | undefined {
    return this.fallbackService;
  }

  async getProfileByTenantId(tenantId: string): Promise<MerchantProfileDto | null> {
    try {
      const res = await this.request<MerchantProfileDto | null>(
        `/internal/merchants/tenants/${encodeURIComponent(tenantId)}`,
        'GET',
      );
      return res;
    } catch (err) {
      if (err instanceof NotFoundError) {
        return null;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpMerchantClient: getProfileByTenantId failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          tenantId,
        });
        return this.fallbackService.getProfileByTenantId(tenantId);
      }
      throw err;
    }
  }

  async getProfile(actor: AuthorizedActor): Promise<MerchantProfileDto> {
    try {
      return await this.request<MerchantProfileDto>('/merchants/me', 'GET', undefined, actor);
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof ForbiddenError ||
        err instanceof ValidationError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpMerchantClient: getProfile failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          tenantId: actor.tenantId,
        });
        return this.fallbackService.getProfile(actor);
      }
      throw err;
    }
  }

  async onboard(actor: AuthorizedActor, input: OnboardMerchantInput): Promise<MerchantProfileDto> {
    try {
      return await this.request<MerchantProfileDto>('/merchants/onboard', 'POST', input, actor);
    } catch (err) {
      if (
        err instanceof ConflictError ||
        err instanceof ValidationError ||
        err instanceof ForbiddenError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpMerchantClient: onboard failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          tenantId: actor.tenantId,
        });
        return this.fallbackService.onboard(actor, input);
      }
      throw err;
    }
  }

  async updateProfile(
    actor: AuthorizedActor,
    updates: UpdateMerchantProfileInput,
  ): Promise<MerchantProfileDto> {
    try {
      return await this.request<MerchantProfileDto>('/merchants/me', 'PATCH', updates, actor);
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof ForbiddenError ||
        err instanceof ValidationError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpMerchantClient: updateProfile failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          tenantId: actor.tenantId,
        });
        return this.fallbackService.updateProfile(actor, updates);
      }
      throw err;
    }
  }

  async submitForVerification(actor: AuthorizedActor): Promise<MerchantProfileDto> {
    try {
      return await this.request<MerchantProfileDto>('/merchants/me/submit', 'POST', undefined, actor);
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof ForbiddenError ||
        err instanceof ValidationError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpMerchantClient: submitForVerification failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          tenantId: actor.tenantId,
        });
        return this.fallbackService.submitForVerification(actor);
      }
      throw err;
    }
  }

  async approveMerchant(
    actor: AuthorizedActor,
    targetTenantId: string,
  ): Promise<MerchantProfileDto> {
    try {
      return await this.request<MerchantProfileDto>(
        `/merchants/${encodeURIComponent(targetTenantId)}/approve`,
        'POST',
        undefined,
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
        this.logger?.warn('HttpMerchantClient: approveMerchant failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          targetTenantId,
        });
        return this.fallbackService.approveMerchant(actor, targetTenantId);
      }
      throw err;
    }
  }

  async rejectMerchant(
    actor: AuthorizedActor,
    targetTenantId: string,
    reason: string,
  ): Promise<MerchantProfileDto> {
    try {
      return await this.request<MerchantProfileDto>(
        `/merchants/${encodeURIComponent(targetTenantId)}/reject`,
        'POST',
        { reason },
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
        this.logger?.warn('HttpMerchantClient: rejectMerchant failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          targetTenantId,
        });
        return this.fallbackService.rejectMerchant(actor, targetTenantId, reason);
      }
      throw err;
    }
  }

  async listMerchants(actor: AuthorizedActor): Promise<MerchantProfileDto[]> {
    try {
      return await this.request<MerchantProfileDto[]>('/merchants', 'GET', undefined, actor);
    } catch (err) {
      if (this.fallbackService) {
        this.logger?.warn('HttpMerchantClient: listMerchants failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
        });
        return this.fallbackService.listMerchants(actor);
      }
      throw err;
    }
  }

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
          const json = await response.json() as { message?: string };
          if (json.message) msg = json.message;
        } catch {
          // ignore
        }
        throw new ValidationError(msg);
      }
      if (response.status === 403) {
        let msg = 'Forbidden';
        try {
          const json = await response.json() as { message?: string };
          if (json.message) msg = json.message;
        } catch {
          // ignore
        }
        throw new ForbiddenError(msg);
      }
      if (response.status === 409) {
        let msg = 'Conflict';
        try {
          const json = await response.json() as { message?: string };
          if (json.message) msg = json.message;
        } catch {
          // ignore
        }
        throw new ConflictError(msg);
      }

      if (!response.ok) {
        let errorBody = '';
        try {
          errorBody = await response.text();
        } catch {
          // ignore
        }
        throw new ExternalServiceError(
          `Merchant service responded with HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
        );
      }

      return (await response.json()) as T;
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof ValidationError ||
        err instanceof ForbiddenError ||
        err instanceof ConflictError ||
        err instanceof ExternalServiceError
      ) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort') || message.includes('timeout')) {
        throw new ExternalServiceError(
          `Merchant service request timed out after ${this.timeoutMs}ms: ${path}`,
        );
      }
      throw new ExternalServiceError(`Failed to communicate with merchant service: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
