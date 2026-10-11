import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type {
  IPaymentService,
  CreatePaymentIntentInput,
  CreatePaymentAttemptInput,
  CreateRefundInput,
  PaymentIntentDto,
  PaymentAttemptDto,
  PaymentRefundDto,
  WebhookProcessResultDto,
} from './payment-models.js';
import type { Logger } from '../../../observability/logger.js';
import {
  ExternalServiceError,
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';

export interface HttpPaymentClientOptions {
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  fallbackService?: IPaymentService | undefined;
  logger?: Logger | undefined;
}

/**
 * HttpPaymentClient - Remote Payment Microservice HTTP Client.
 *
 * Implements IPaymentService to delegate payment intents, attempts, refunds,
 * and webhooks to a standalone payment-service over HTTP.
 */
export class HttpPaymentClient implements IPaymentService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallbackService?: IPaymentService | undefined;
  private readonly logger?: Logger | undefined;

  constructor(serviceUrl: string, options: HttpPaymentClientOptions = {}) {
    this.baseUrl = serviceUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.fallbackService = options.fallbackService;
    this.logger = options.logger;
  }

  getFallbackService(): IPaymentService | undefined {
    return this.fallbackService;
  }

  async createPaymentIntent(
    actor: AuthorizedActor,
    input: CreatePaymentIntentInput,
  ): Promise<PaymentIntentDto> {
    try {
      return await this.request<PaymentIntentDto>('POST', '/payments/intents', actor, input);
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote payment service failed; falling back to local payment service', {
          error: (err as Error).message,
        });
        return this.fallbackService.createPaymentIntent(actor, input);
      }
      throw err;
    }
  }

  async getPaymentIntent(actor: AuthorizedActor, id: string): Promise<PaymentIntentDto> {
    try {
      return await this.request<PaymentIntentDto>(
        'GET',
        `/payments/intents/${encodeURIComponent(id)}`,
        actor,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote payment service failed; falling back to local payment service', {
          error: (err as Error).message,
        });
        return this.fallbackService.getPaymentIntent(actor, id);
      }
      throw err;
    }
  }

  async createPaymentAttempt(
    actor: AuthorizedActor,
    intentId: string,
    input: CreatePaymentAttemptInput,
  ): Promise<PaymentAttemptDto> {
    try {
      return await this.request<PaymentAttemptDto>(
        'POST',
        `/payments/intents/${encodeURIComponent(intentId)}/attempts`,
        actor,
        input,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote payment service failed; falling back to local payment service', {
          error: (err as Error).message,
        });
        return this.fallbackService.createPaymentAttempt(actor, intentId, input);
      }
      throw err;
    }
  }

  async createRefund(
    actor: AuthorizedActor,
    intentId: string,
    input: CreateRefundInput,
  ): Promise<PaymentRefundDto> {
    try {
      return await this.request<PaymentRefundDto>(
        'POST',
        `/payments/intents/${encodeURIComponent(intentId)}/refund`,
        actor,
        input,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote payment service failed; falling back to local payment service', {
          error: (err as Error).message,
        });
        return this.fallbackService.createRefund(actor, intentId, input);
      }
      throw err;
    }
  }

  async linkOrderToIntent(intentId: string, orderId: string): Promise<void> {
    try {
      await this.request<{ linked: boolean }>(
        'PATCH',
        `/payments/intents/${encodeURIComponent(intentId)}/order`,
        undefined,
        { orderId },
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        return this.fallbackService.linkOrderToIntent(intentId, orderId);
      }
      this.logger?.warn('Remote payment service failed to link order; best-effort ignored', {
        intentId,
        orderId,
        error: (err as Error).message,
      });
    }
  }

  async listAllPayments(actor: AuthorizedActor): Promise<PaymentIntentDto[]> {
    try {
      return await this.request<PaymentIntentDto[]>('GET', '/admin/payments', actor);
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        return this.fallbackService.listAllPayments(actor);
      }
      throw err;
    }
  }

  async processWebhook(
    providerName: string,
    rawPayload: string,
    signatureHeader: string,
  ): Promise<WebhookProcessResultDto> {
    const url = `${this.baseUrl}/payments/webhooks/${encodeURIComponent(providerName)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-webhook-signature': signatureHeader,
        'stripe-signature': signatureHeader,
      };

      const response = await this.fetchFn(url, {
        method: 'POST',
        headers,
        body: rawPayload,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.handleErrorResponse(response.status, errorText);
      }

      const data = (await response.json()) as WebhookProcessResultDto & { received?: boolean };
      return {
        processed: data.processed,
        duplicate: data.duplicate,
        providerEventId: data.providerEventId,
        eventType: data.eventType,
      };
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote payment service failed for webhook; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.processWebhook(providerName, rawPayload, signatureHeader);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    actor?: AuthorizedActor,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    if (actor) {
      headers['x-user-id'] = actor.userId;
      headers['x-tenant-id'] = actor.tenantId;
      headers['x-user-role'] = actor.role;
    }

    const init: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    try {
      const response = await this.fetchFn(url, init);

      if (!response.ok) {
        const errorBody = await response.text();
        this.handleErrorResponse(response.status, errorBody);
      }

      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ExternalServiceError(
          `Payment service request timed out after ${this.timeoutMs}ms`,
          'PAYMENT_SERVICE_TIMEOUT',
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private isFallbackEligible(err: unknown): boolean {
    if (err instanceof ExternalServiceError) return true;
    if (err instanceof TypeError && err.message.includes('fetch')) return true;
    if (err instanceof Error) {
      return (
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('ENOTFOUND') ||
        err.message.includes('fetch failed') ||
        err.message.includes('timeout')
      );
    }
    return false;
  }

  private handleErrorResponse(status: number, errorBody: string): never {
    let message = errorBody;
    let code = 'EXTERNAL_SERVICE_ERROR';

    try {
      const parsed = JSON.parse(errorBody) as {
        error?: { code?: string; message?: string };
        message?: string;
      };
      if (parsed.error?.message) message = parsed.error.message;
      else if (parsed.message) message = parsed.message;
      if (parsed.error?.code) code = parsed.error.code;
    } catch {
      // Body not JSON
    }

    if (status === 400) {
      throw new ValidationError(message);
    }
    if (status === 403) {
      throw new ForbiddenError(message);
    }
    if (status === 404) {
      throw new NotFoundError(message);
    }
    if (status === 409) {
      if (code === 'INVALID_STATE_TRANSITION') {
        throw new InvalidStateTransitionError(message);
      }
      throw new ConflictError(message);
    }
    throw new ExternalServiceError(
      `Remote payment service returned HTTP ${status}: ${message}`,
      'PAYMENT_SERVICE_ERROR',
    );
  }
}
