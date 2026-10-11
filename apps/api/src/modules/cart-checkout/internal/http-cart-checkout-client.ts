import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type {
  ICartService,
  ICheckoutService,
  CartDto,
  AddCartItemInput,
  UpdateCartItemQuantityInput,
  CheckoutSessionDto,
  CreateCheckoutSessionInput,
  AddressSnapshot,
} from './cart-checkout-models.js';
import type { Logger } from '../../../observability/logger.js';
import {
  ExternalServiceError,
  NotFoundError,
  ForbiddenError,
  ValidationError,
  EmptyCartError,
  CheckoutValidationError,
  CheckoutExpiredError,
  InvalidStateTransitionError,
  ConflictError,
} from '../../../errors/app-error.js';

export interface HttpCartClientOptions {
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  fallbackService?: ICartService | undefined;
  logger?: Logger | undefined;
}

export interface HttpCheckoutClientOptions {
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  fallbackService?: ICheckoutService | undefined;
  logger?: Logger | undefined;
}

/**
 * HttpCartClient - Remote Shopping Cart Microservice HTTP Client.
 *
 * Implements ICartService to delegate customer shopping cart operations
 * to a standalone cart-checkout-service over HTTP.
 */
export class HttpCartClient implements ICartService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallbackService?: ICartService | undefined;
  private readonly logger?: Logger | undefined;

  constructor(serviceUrl: string, options: HttpCartClientOptions = {}) {
    this.baseUrl = serviceUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.fallbackService = options.fallbackService;
    this.logger = options.logger;
  }

  getFallbackService(): ICartService | undefined {
    return this.fallbackService;
  }

  async getOrCreateCart(actor: AuthorizedActor): Promise<CartDto> {
    try {
      return await this.request<CartDto>('GET', '/cart', actor);
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote cart service failed; falling back to local cart service', {
          error: (err as Error).message,
        });
        return this.fallbackService.getOrCreateCart(actor);
      }
      throw err;
    }
  }

  async addItem(actor: AuthorizedActor, input: AddCartItemInput): Promise<CartDto> {
    try {
      return await this.request<CartDto>('POST', '/cart/items', actor, input);
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote cart service failed; falling back to local cart service', {
          error: (err as Error).message,
        });
        return this.fallbackService.addItem(actor, input);
      }
      throw err;
    }
  }

  async updateItemQuantity(
    actor: AuthorizedActor,
    itemId: string,
    input: UpdateCartItemQuantityInput,
  ): Promise<CartDto> {
    try {
      return await this.request<CartDto>(
        'PATCH',
        `/cart/items/${encodeURIComponent(itemId)}`,
        actor,
        input,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote cart service failed; falling back to local cart service', {
          error: (err as Error).message,
        });
        return this.fallbackService.updateItemQuantity(actor, itemId, input);
      }
      throw err;
    }
  }

  async removeItem(actor: AuthorizedActor, itemId: string): Promise<CartDto> {
    try {
      return await this.request<CartDto>(
        'DELETE',
        `/cart/items/${encodeURIComponent(itemId)}`,
        actor,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote cart service failed; falling back to local cart service', {
          error: (err as Error).message,
        });
        return this.fallbackService.removeItem(actor, itemId);
      }
      throw err;
    }
  }

  async clearCart(actor: AuthorizedActor): Promise<CartDto> {
    try {
      return await this.request<CartDto>('DELETE', '/cart', actor);
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote cart service failed; falling back to local cart service', {
          error: (err as Error).message,
        });
        return this.fallbackService.clearCart(actor);
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
        let errorData: { error?: string; message?: string } = {};
        try {
          errorData = (await response.json()) as { error?: string; message?: string };
        } catch {
          // Non-JSON response
        }

        const msg = errorData.message || errorData.error || response.statusText;

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
          throw new ExternalServiceError(`Cart service HTTP error ${response.status}: ${msg}`);
        }
        throw new ExternalServiceError(`Cart service unexpected status ${response.status}: ${msg}`);
      }

      return (await response.json()) as T;
    } catch (err: unknown) {
      if (
        err instanceof ValidationError ||
        err instanceof ForbiddenError ||
        err instanceof NotFoundError ||
        err instanceof ConflictError ||
        err instanceof ExternalServiceError
      ) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort') || message.includes('timeout')) {
        throw new ExternalServiceError(
          `Cart service request timed out after ${this.timeoutMs}ms: ${path}`,
        );
      }
      throw new ExternalServiceError(`Failed to communicate with cart service: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * HttpCheckoutClient - Remote Checkout Microservice HTTP Client.
 *
 * Implements ICheckoutService to delegate checkout session creation,
 * address assignment, atomic CAS inventory reservation, and session termination over HTTP.
 */
export class HttpCheckoutClient implements ICheckoutService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallbackService?: ICheckoutService | undefined;
  private readonly logger?: Logger | undefined;

  constructor(serviceUrl: string, options: HttpCheckoutClientOptions = {}) {
    this.baseUrl = serviceUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.fallbackService = options.fallbackService;
    this.logger = options.logger;
  }

  getFallbackService(): ICheckoutService | undefined {
    return this.fallbackService;
  }

  async createCheckoutSession(
    actor: AuthorizedActor,
    input?: CreateCheckoutSessionInput,
  ): Promise<CheckoutSessionDto> {
    try {
      return await this.request<CheckoutSessionDto>(
        'POST',
        '/checkout/sessions',
        actor,
        input ?? {},
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote checkout service failed; falling back to local checkout service', {
          error: (err as Error).message,
        });
        return this.fallbackService.createCheckoutSession(actor, input);
      }
      throw err;
    }
  }

  async setShippingAddress(
    actor: AuthorizedActor,
    sessionId: string,
    input: {
      addressId?: string | null | undefined;
      shippingAddress?: AddressSnapshot | Record<string, unknown> | null | undefined;
    },
  ): Promise<CheckoutSessionDto> {
    try {
      return await this.request<CheckoutSessionDto>(
        'POST',
        `/checkout/sessions/${encodeURIComponent(sessionId)}/address`,
        actor,
        input,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote checkout service failed; falling back to local checkout service', {
          error: (err as Error).message,
        });
        return this.fallbackService.setShippingAddress(actor, sessionId, input);
      }
      throw err;
    }
  }

  async reserveCheckoutInventory(
    actor: AuthorizedActor,
    sessionId: string,
  ): Promise<CheckoutSessionDto> {
    try {
      return await this.request<CheckoutSessionDto>(
        'POST',
        `/checkout/sessions/${encodeURIComponent(sessionId)}/reserve`,
        actor,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote checkout service failed; falling back to local checkout service', {
          error: (err as Error).message,
        });
        return this.fallbackService.reserveCheckoutInventory(actor, sessionId);
      }
      throw err;
    }
  }

  async getCheckoutSession(
    actor: AuthorizedActor,
    sessionId: string,
  ): Promise<CheckoutSessionDto> {
    try {
      return await this.request<CheckoutSessionDto>(
        'GET',
        `/checkout/sessions/${encodeURIComponent(sessionId)}`,
        actor,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote checkout service failed; falling back to local checkout service', {
          error: (err as Error).message,
        });
        return this.fallbackService.getCheckoutSession(actor, sessionId);
      }
      throw err;
    }
  }

  async expireCheckoutSession(
    actor: AuthorizedActor,
    sessionId: string,
  ): Promise<CheckoutSessionDto> {
    try {
      return await this.request<CheckoutSessionDto>(
        'POST',
        `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
        actor,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote checkout service failed; falling back to local checkout service', {
          error: (err as Error).message,
        });
        return this.fallbackService.expireCheckoutSession(actor, sessionId);
      }
      throw err;
    }
  }

  async cancelCheckoutSession(
    actor: AuthorizedActor,
    sessionId: string,
  ): Promise<CheckoutSessionDto> {
    try {
      return await this.request<CheckoutSessionDto>(
        'POST',
        `/checkout/sessions/${encodeURIComponent(sessionId)}/cancel`,
        actor,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote checkout service failed; falling back to local checkout service', {
          error: (err as Error).message,
        });
        return this.fallbackService.cancelCheckoutSession(actor, sessionId);
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
        let errorData: { error?: string; message?: string; name?: string } = {};
        try {
          errorData = (await response.json()) as { error?: string; message?: string; name?: string };
        } catch {
          // Non-JSON response
        }

        const msg = errorData.message || errorData.error || response.statusText;
        const errName = errorData.name || '';

        if (errName === 'EmptyCartError' || msg.includes('empty cart') || msg.includes('without an active cart')) {
          throw new EmptyCartError(msg);
        }
        if (errName === 'CheckoutExpiredError' || msg.includes('has expired')) {
          throw new CheckoutExpiredError(msg);
        }
        if (errName === 'CheckoutValidationError' || msg.includes('Idempotency key reuse detected')) {
          throw new CheckoutValidationError(msg);
        }
        if (errName === 'InvalidStateTransitionError' || msg.includes('Cannot reserve') || msg.includes('Cannot expire') || msg.includes('Cannot cancel')) {
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
          throw new ExternalServiceError(`Checkout service HTTP error ${response.status}: ${msg}`);
        }
        throw new ExternalServiceError(
          `Checkout service unexpected status ${response.status}: ${msg}`,
        );
      }

      return (await response.json()) as T;
    } catch (err: unknown) {
      if (
        err instanceof ValidationError ||
        err instanceof ForbiddenError ||
        err instanceof NotFoundError ||
        err instanceof ConflictError ||
        err instanceof EmptyCartError ||
        err instanceof CheckoutValidationError ||
        err instanceof CheckoutExpiredError ||
        err instanceof InvalidStateTransitionError ||
        err instanceof ExternalServiceError
      ) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort') || message.includes('timeout')) {
        throw new ExternalServiceError(
          `Checkout service request timed out after ${this.timeoutMs}ms: ${path}`,
        );
      }
      throw new ExternalServiceError(`Failed to communicate with checkout service: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
