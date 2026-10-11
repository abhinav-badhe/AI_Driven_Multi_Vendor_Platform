import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type {
  IFulfillmentService,
  CreateShipmentInput,
  UpdateShipmentTrackingInput,
  CreateReturnInput,
  UpdateReturnStatusOptions,
  ShipmentDto,
  ReturnDto,
  ShipmentStatus,
  ReturnStatus,
  CarrierCallbackResultDto,
} from './fulfillment-models.js';
import type { CarrierTrackingEvent } from './carrier-provider.js';
import type { Logger } from '../../../observability/logger.js';
import {
  ExternalServiceError,
  NotFoundError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
  ConflictError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';

export interface HttpFulfillmentClientOptions {
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  fallbackService?: IFulfillmentService | undefined;
  logger?: Logger | undefined;
}

/**
 * HttpFulfillmentClient - Remote Fulfillment Microservice HTTP Client.
 *
 * Implements IFulfillmentService to delegate warehouse shipments, carrier labels,
 * return requests, and carrier telemetry to a standalone fulfillment-service over HTTP.
 */
export class HttpFulfillmentClient implements IFulfillmentService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallbackService?: IFulfillmentService | undefined;
  private readonly logger?: Logger | undefined;

  constructor(serviceUrl: string, options: HttpFulfillmentClientOptions = {}) {
    this.baseUrl = serviceUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.fallbackService = options.fallbackService;
    this.logger = options.logger;
  }

  getFallbackService(): IFulfillmentService | undefined {
    return this.fallbackService;
  }

  async createShipment(
    actor: AuthorizedActor,
    input: CreateShipmentInput,
  ): Promise<ShipmentDto> {
    try {
      return await this.request<ShipmentDto>('POST', '/fulfillment/shipments', actor, input);
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote fulfillment service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.createShipment(actor, input);
      }
      throw err;
    }
  }

  async getShipment(actor: AuthorizedActor, id: string): Promise<ShipmentDto> {
    try {
      return await this.request<ShipmentDto>(
        'GET',
        `/fulfillment/shipments/${encodeURIComponent(id)}`,
        actor,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote fulfillment service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.getShipment(actor, id);
      }
      throw err;
    }
  }

  async listShipments(
    actor: AuthorizedActor,
    filter?: { sellerOrderId?: string | undefined; customerOrderId?: string | undefined } | undefined,
  ): Promise<ShipmentDto[]> {
    const params = new URLSearchParams();
    if (filter?.sellerOrderId) params.set('sellerOrderId', filter.sellerOrderId);
    if (filter?.customerOrderId) params.set('customerOrderId', filter.customerOrderId);
    const query = params.toString() ? `?${params.toString()}` : '';

    try {
      return await this.request<ShipmentDto[]>('GET', `/fulfillment/shipments${query}`, actor);
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote fulfillment service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.listShipments(actor, filter);
      }
      throw err;
    }
  }

  async updateShipmentStatus(
    actor: AuthorizedActor,
    shipmentId: string,
    nextStatus: ShipmentStatus,
  ): Promise<ShipmentDto> {
    try {
      return await this.request<ShipmentDto>(
        'POST',
        `/fulfillment/shipments/${encodeURIComponent(shipmentId)}/status`,
        actor,
        { status: nextStatus },
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote fulfillment service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.updateShipmentStatus(actor, shipmentId, nextStatus);
      }
      throw err;
    }
  }

  async updateShipmentTracking(
    actor: AuthorizedActor,
    shipmentId: string,
    input: UpdateShipmentTrackingInput,
  ): Promise<ShipmentDto> {
    try {
      return await this.request<ShipmentDto>(
        'POST',
        `/fulfillment/shipments/${encodeURIComponent(shipmentId)}/tracking`,
        actor,
        input,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote fulfillment service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.updateShipmentTracking(actor, shipmentId, input);
      }
      throw err;
    }
  }

  async cancelShipment(actor: AuthorizedActor, shipmentId: string): Promise<ShipmentDto> {
    try {
      return await this.request<ShipmentDto>(
        'POST',
        `/fulfillment/shipments/${encodeURIComponent(shipmentId)}/cancel`,
        actor,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote fulfillment service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.cancelShipment(actor, shipmentId);
      }
      throw err;
    }
  }

  async getShipmentTracking(
    actor: AuthorizedActor,
    shipmentId: string,
  ): Promise<CarrierTrackingEvent> {
    try {
      return await this.request<CarrierTrackingEvent>(
        'GET',
        `/fulfillment/shipments/${encodeURIComponent(shipmentId)}/tracking`,
        actor,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote fulfillment service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.getShipmentTracking(actor, shipmentId);
      }
      throw err;
    }
  }

  async createReturnRequest(
    actor: AuthorizedActor,
    input: CreateReturnInput,
  ): Promise<ReturnDto> {
    try {
      return await this.request<ReturnDto>('POST', '/fulfillment/returns', actor, input);
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote fulfillment service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.createReturnRequest(actor, input);
      }
      throw err;
    }
  }

  async getReturn(actor: AuthorizedActor, returnId: string): Promise<ReturnDto> {
    try {
      return await this.request<ReturnDto>(
        'GET',
        `/fulfillment/returns/${encodeURIComponent(returnId)}`,
        actor,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote fulfillment service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.getReturn(actor, returnId);
      }
      throw err;
    }
  }

  async listReturns(
    actor: AuthorizedActor,
    filter?: { customerOrderId?: string | undefined; sellerOrderId?: string | undefined } | undefined,
  ): Promise<ReturnDto[]> {
    const params = new URLSearchParams();
    if (filter?.customerOrderId) params.set('customerOrderId', filter.customerOrderId);
    if (filter?.sellerOrderId) params.set('sellerOrderId', filter.sellerOrderId);
    const query = params.toString() ? `?${params.toString()}` : '';

    try {
      return await this.request<ReturnDto[]>('GET', `/fulfillment/returns${query}`, actor);
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote fulfillment service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.listReturns(actor, filter);
      }
      throw err;
    }
  }

  async updateReturnStatus(
    actor: AuthorizedActor,
    returnId: string,
    nextStatus: ReturnStatus,
    options?: UpdateReturnStatusOptions | undefined,
  ): Promise<ReturnDto> {
    try {
      return await this.request<ReturnDto>(
        'POST',
        `/fulfillment/returns/${encodeURIComponent(returnId)}/status`,
        actor,
        { status: nextStatus, ...(options ?? {}) },
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote fulfillment service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.updateReturnStatus(actor, returnId, nextStatus, options);
      }
      throw err;
    }
  }

  async handleCarrierCallback(
    rawBody: string,
    signatureHeader: string,
  ): Promise<CarrierCallbackResultDto> {
    const url = `${this.baseUrl}/fulfillment/carrier/callback`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'shippo-signature': signatureHeader,
        'x-carrier-signature': signatureHeader,
      };

      const response = await this.fetchFn(url, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.handleErrorResponse(response.status, errorText);
      }

      return (await response.json()) as CarrierCallbackResultDto;
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote fulfillment service failed for callback; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.handleCarrierCallback(rawBody, signatureHeader);
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
          `Fulfillment service request timed out after ${this.timeoutMs}ms`,
          'FULFILLMENT_SERVICE_TIMEOUT',
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
    if (status === 401) {
      throw new UnauthorizedError(message);
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
      `Remote fulfillment service returned HTTP ${status}: ${message}`,
      'FULFILLMENT_SERVICE_ERROR',
    );
  }
}
