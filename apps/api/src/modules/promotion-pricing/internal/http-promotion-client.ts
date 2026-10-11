import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  UnauthorizedError,
  ExternalServiceError,
} from '../../../errors/app-error.js';
import type {
  PromotionDto,
  CreatePromotionInput,
  UpdatePromotionInput,
  DiscountCalculationResult,
  IPromotionPricingEngine,
  ListPromotionsFilter,
  PreviewDiscountsInput,
  ApplyCouponResult,
  RemoveCouponResult,
} from './promotion-models.js';

export interface HttpPromotionPricingClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly fallbackEngine?: IPromotionPricingEngine | undefined;
}

export class HttpPromotionPricingClient implements IPromotionPricingEngine {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallbackEngine?: IPromotionPricingEngine | undefined;

  constructor(options: HttpPromotionPricingClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.fallbackEngine = options.fallbackEngine;
  }

  private async request<T>(
    actor: AuthorizedActor,
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-user-id': actor.userId,
      'x-tenant-id': actor.tenantId,
      'x-user-role': actor.role,
    };

    try {
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      const response = await this.fetchFn(url, init);

      if (response.ok) {
        if (response.status === 204) {
          return undefined as unknown as T;
        }
        return (await response.json()) as T;
      }

      let errorMessage = `Promotion service HTTP error (${response.status})`;
      try {
        const errorBody = (await response.json()) as { message?: string; error?: string };
        if (errorBody?.message) {
          errorMessage = errorBody.message;
        } else if (errorBody?.error) {
          errorMessage = errorBody.error;
        }
      } catch {
        // use default errorMessage
      }

      if (response.status === 400) {
        throw new ValidationError(errorMessage);
      }
      if (response.status === 401) {
        throw new UnauthorizedError(errorMessage);
      }
      if (response.status === 403) {
        throw new ForbiddenError(errorMessage);
      }
      if (response.status === 404) {
        throw new NotFoundError(errorMessage);
      }
      if (response.status === 409) {
        throw new ConflictError(errorMessage);
      }

      throw new ExternalServiceError(errorMessage);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async createPromotion(actor: AuthorizedActor, input: CreatePromotionInput): Promise<PromotionDto> {
    try {
      return await this.request<PromotionDto>(actor, '/v1/promotions', 'POST', input);
    } catch (err) {
      if (this.fallbackEngine && !(err instanceof ValidationError) && !(err instanceof ForbiddenError) && !(err instanceof ConflictError)) {
        return this.fallbackEngine.createPromotion(actor, input);
      }
      throw err;
    }
  }

  async getPromotion(actor: AuthorizedActor, id: string): Promise<PromotionDto> {
    try {
      return await this.request<PromotionDto>(actor, `/v1/promotions/${encodeURIComponent(id)}`, 'GET');
    } catch (err) {
      if (this.fallbackEngine && !(err instanceof NotFoundError) && !(err instanceof ForbiddenError)) {
        return this.fallbackEngine.getPromotion(actor, id);
      }
      throw err;
    }
  }

  async listPromotions(actor: AuthorizedActor, filter?: ListPromotionsFilter): Promise<PromotionDto[]> {
    const params = new URLSearchParams();
    if (filter?.merchantTenantId) params.set('merchantTenantId', filter.merchantTenantId);
    if (filter?.includePlatform) params.set('includePlatform', 'true');
    if (filter?.status) params.set('status', filter.status);
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter?.offset !== undefined) params.set('offset', String(filter.offset));

    const queryString = params.toString() ? `?${params.toString()}` : '';

    try {
      return await this.request<PromotionDto[]>(actor, `/v1/promotions${queryString}`, 'GET');
    } catch (err) {
      if (this.fallbackEngine) {
        return this.fallbackEngine.listPromotions(actor, filter);
      }
      throw err;
    }
  }

  async updatePromotion(actor: AuthorizedActor, id: string, input: UpdatePromotionInput): Promise<PromotionDto> {
    try {
      return await this.request<PromotionDto>(actor, `/v1/promotions/${encodeURIComponent(id)}`, 'PATCH', input);
    } catch (err) {
      if (this.fallbackEngine && !(err instanceof NotFoundError) && !(err instanceof ForbiddenError) && !(err instanceof ValidationError)) {
        return this.fallbackEngine.updatePromotion(actor, id, input);
      }
      throw err;
    }
  }

  async previewDiscounts(actor: AuthorizedActor, input: PreviewDiscountsInput): Promise<DiscountCalculationResult> {
    try {
      return await this.request<DiscountCalculationResult>(actor, '/v1/promotions/preview', 'POST', input);
    } catch (err) {
      if (this.fallbackEngine && !(err instanceof ValidationError) && !(err instanceof NotFoundError)) {
        return this.fallbackEngine.previewDiscounts(actor, input);
      }
      throw err;
    }
  }

  async applyCouponToCheckout(
    actor: AuthorizedActor,
    checkoutSessionId: string,
    couponCode: string,
  ): Promise<ApplyCouponResult> {
    try {
      return await this.request<ApplyCouponResult>(
        actor,
        `/v1/checkouts/${encodeURIComponent(checkoutSessionId)}/coupon`,
        'POST',
        { couponCode },
      );
    } catch (err) {
      if (this.fallbackEngine && !(err instanceof NotFoundError) && !(err instanceof ValidationError)) {
        return this.fallbackEngine.applyCouponToCheckout(actor, checkoutSessionId, couponCode);
      }
      throw err;
    }
  }

  async removeCouponFromCheckout(
    actor: AuthorizedActor,
    checkoutSessionId: string,
  ): Promise<RemoveCouponResult> {
    try {
      return await this.request<RemoveCouponResult>(
        actor,
        `/v1/checkouts/${encodeURIComponent(checkoutSessionId)}/coupon`,
        'DELETE',
      );
    } catch (err) {
      if (this.fallbackEngine && !(err instanceof NotFoundError)) {
        return this.fallbackEngine.removeCouponFromCheckout(actor, checkoutSessionId);
      }
      throw err;
    }
  }
}
