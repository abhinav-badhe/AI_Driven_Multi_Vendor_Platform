import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type {
  IOrderService,
  CreateOrderInput,
  CustomerOrderDto,
  SellerOrderDto,
  CustomerOrderStatus,
  SellerOrderStatus,
} from './order-models.js';
import type { Logger } from '../../../observability/logger.js';
import {
  ExternalServiceError,
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';

export interface HttpOrderClientOptions {
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  fallbackService?: IOrderService | undefined;
  logger?: Logger | undefined;
}

/**
 * HttpOrderClient - Remote Order Microservice HTTP Client.
 *
 * Implements IOrderService to delegate order placement, multi-vendor seller order queries,
 * and status updates to a standalone order-service over HTTP.
 */
export class HttpOrderClient implements IOrderService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallbackService?: IOrderService | undefined;
  private readonly logger?: Logger | undefined;

  constructor(serviceUrl: string, options: HttpOrderClientOptions = {}) {
    this.baseUrl = serviceUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.fallbackService = options.fallbackService;
    this.logger = options.logger;
  }

  getFallbackService(): IOrderService | undefined {
    return this.fallbackService;
  }

  async createOrderFromCheckout(
    actor: AuthorizedActor,
    input: CreateOrderInput,
  ): Promise<CustomerOrderDto> {
    try {
      return await this.request<CustomerOrderDto>('POST', '/orders', actor, input);
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote order service failed; falling back to local order service', {
          error: (err as Error).message,
        });
        return this.fallbackService.createOrderFromCheckout(actor, input);
      }
      throw err;
    }
  }

  async getCustomerOrder(actor: AuthorizedActor, id: string): Promise<CustomerOrderDto> {
    try {
      return await this.request<CustomerOrderDto>(
        'GET',
        `/orders/${encodeURIComponent(id)}`,
        actor,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote order service failed; falling back to local order service', {
          error: (err as Error).message,
        });
        return this.fallbackService.getCustomerOrder(actor, id);
      }
      throw err;
    }
  }

  async listCustomerOrders(
    actor: AuthorizedActor,
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<CustomerOrderDto[]> {
    const params = new URLSearchParams();
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter?.offset !== undefined) params.set('offset', String(filter.offset));
    const query = params.toString() ? `?${params.toString()}` : '';

    try {
      return await this.request<CustomerOrderDto[]>('GET', `/orders${query}`, actor);
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote order service failed; falling back to local order service', {
          error: (err as Error).message,
        });
        return this.fallbackService.listCustomerOrders(actor, filter);
      }
      throw err;
    }
  }

  async getSellerOrder(actor: AuthorizedActor, id: string): Promise<SellerOrderDto> {
    try {
      return await this.request<SellerOrderDto>(
        'GET',
        `/seller/orders/${encodeURIComponent(id)}`,
        actor,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote order service failed; falling back to local order service', {
          error: (err as Error).message,
        });
        return this.fallbackService.getSellerOrder(actor, id);
      }
      throw err;
    }
  }

  async listSellerOrders(
    actor: AuthorizedActor,
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<SellerOrderDto[]> {
    const params = new URLSearchParams();
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter?.offset !== undefined) params.set('offset', String(filter.offset));
    const query = params.toString() ? `?${params.toString()}` : '';

    try {
      return await this.request<SellerOrderDto[]>('GET', `/seller/orders${query}`, actor);
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote order service failed; falling back to local order service', {
          error: (err as Error).message,
        });
        return this.fallbackService.listSellerOrders(actor, filter);
      }
      throw err;
    }
  }

  async updateCustomerOrderStatus(
    actor: AuthorizedActor,
    orderId: string,
    nextStatus: CustomerOrderStatus,
  ): Promise<CustomerOrderDto> {
    try {
      return await this.request<CustomerOrderDto>(
        'PATCH',
        `/orders/${encodeURIComponent(orderId)}/status`,
        actor,
        { status: nextStatus },
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote order service failed; falling back to local order service', {
          error: (err as Error).message,
        });
        return this.fallbackService.updateCustomerOrderStatus(actor, orderId, nextStatus);
      }
      throw err;
    }
  }

  async updateSellerOrderStatus(
    actor: AuthorizedActor,
    sellerOrderId: string,
    nextStatus: SellerOrderStatus,
  ): Promise<SellerOrderDto> {
    try {
      return await this.request<SellerOrderDto>(
        'PATCH',
        `/seller/orders/${encodeURIComponent(sellerOrderId)}/status`,
        actor,
        { status: nextStatus },
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote order service failed; falling back to local order service', {
          error: (err as Error).message,
        });
        return this.fallbackService.updateSellerOrderStatus(actor, sellerOrderId, nextStatus);
      }
      throw err;
    }
  }

  private isFallbackEligible(err: unknown): boolean {
    if (err instanceof ExternalServiceError) return true;
    if (err instanceof TypeError) return true;
    const msg = err instanceof Error ? err.message : '';
    return msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('timeout');
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    actor: AuthorizedActor,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const requestInit: RequestInit = {
        method,
        headers: {
          'x-user-id': actor.userId,
          'x-tenant-id': actor.tenantId,
          'x-user-role': actor.role,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        signal: controller.signal,
      };
      if (body !== undefined) {
        requestInit.body = JSON.stringify(body);
      }

      const response = await this.fetchFn(url, requestInit);

      if (!response.ok) {
        let errorData: { error?: unknown; message?: string; name?: string } = {};
        try {
          errorData = (await response.json()) as { error?: unknown; message?: string; name?: string };
        } catch {
          // Non-JSON response
        }

        const msg =
          typeof errorData.error === 'object' && errorData.error !== null
            ? (errorData.error as { message?: string }).message || response.statusText
            : typeof errorData.error === 'string'
              ? errorData.error
              : errorData.message || response.statusText;

        const errName = errorData.name || '';

        if (
          errName === 'InvalidStateTransitionError' ||
          msg.includes('Invalid') ||
          msg.includes('transition') ||
          msg.includes('Cannot finalize order')
        ) {
          throw new InvalidStateTransitionError(msg);
        }
        if (response.status === 400) {
          throw new ValidationError(msg);
        }
        if (response.status === 403) {
          throw new ForbiddenError(msg);
        }
        if (response.status === 404) {
          throw new NotFoundError(msg);
        }
        if (response.status === 409) {
          throw new ConflictError(msg);
        }
        if (response.status >= 500) {
          throw new ExternalServiceError(`Order service HTTP error ${response.status}: ${msg}`);
        }
        throw new ExternalServiceError(`Order service unexpected status ${response.status}: ${msg}`);
      }

      return (await response.json()) as T;
    } catch (err: unknown) {
      if (
        err instanceof ValidationError ||
        err instanceof ForbiddenError ||
        err instanceof NotFoundError ||
        err instanceof ConflictError ||
        err instanceof InvalidStateTransitionError ||
        err instanceof ExternalServiceError
      ) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort') || message.includes('timeout')) {
        throw new ExternalServiceError(
          `Order service request timed out after ${this.timeoutMs}ms: ${path}`,
        );
      }
      throw new ExternalServiceError(`Failed to communicate with order service: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
