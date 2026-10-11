import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type {
  IInventoryService,
  InventoryItemDto,
  InventoryAvailabilityDto,
  InventoryReservationDto,
  InventoryMovementDto,
  InitializeInventoryInput,
  CreateReservationInput,
} from './inventory-models.js';
import type { Logger } from '../../../observability/logger.js';
import {
  ExternalServiceError,
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  InvalidStateTransitionError,
  InsufficientInventoryError,
} from '../../../errors/app-error.js';

export interface HttpInventoryClientOptions {
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  fallbackService?: IInventoryService | undefined;
  logger?: Logger | undefined;
}

/**
 * HttpInventoryClient - Remote Inventory Microservice HTTP Client.
 *
 * Implements IInventoryService to delegate stock levels, CAS reservations,
 * movements, and multi-warehouse allocations to a standalone inventory-service over HTTP.
 *
 * Resilience:
 * - Configurable request timeout via AbortController.
 * - Propagates identity context (x-user-id, x-tenant-id, x-user-role) for cross-service authorization.
 * - Graceful fallback to local SQL/in-memory InventoryStore on network or 5xx server failure.
 */
export class HttpInventoryClient implements IInventoryService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallbackService?: IInventoryService | undefined;
  private readonly logger?: Logger | undefined;

  constructor(serviceUrl: string, options: HttpInventoryClientOptions = {}) {
    this.baseUrl = serviceUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.fallbackService = options.fallbackService;
    this.logger = options.logger;
  }

  getFallbackService(): IInventoryService | undefined {
    return this.fallbackService;
  }

  async initializeInventory(
    actor: AuthorizedActor,
    input: InitializeInventoryInput,
  ): Promise<InventoryItemDto> {
    try {
      return await this.request<InventoryItemDto>('/inventory', 'POST', input, actor);
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
        this.logger?.warn('HttpInventoryClient: initializeInventory failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
        });
        return this.fallbackService.initializeInventory(actor, input);
      }
      throw err;
    }
  }

  async listInventory(
    actor: AuthorizedActor,
    filter?: { limit?: number | undefined; offset?: number | undefined },
  ): Promise<InventoryItemDto[]> {
    const params = new URLSearchParams();
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter?.offset !== undefined) params.set('offset', String(filter.offset));
    const qs = params.toString() ? `?${params.toString()}` : '';

    try {
      return await this.request<InventoryItemDto[]>(`/inventory${qs}`, 'GET', undefined, actor);
    } catch (err) {
      if (err instanceof ForbiddenError || err instanceof ValidationError) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpInventoryClient: listInventory failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
        });
        return this.fallbackService.listInventory(actor, filter);
      }
      throw err;
    }
  }

  async getInventoryById(actor: AuthorizedActor, id: string): Promise<InventoryItemDto> {
    try {
      return await this.request<InventoryItemDto>(
        `/inventory/${encodeURIComponent(id)}`,
        'GET',
        undefined,
        actor,
      );
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof ForbiddenError) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpInventoryClient: getInventoryById failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          id,
        });
        return this.fallbackService.getInventoryById(actor, id);
      }
      throw err;
    }
  }

  async getInventoryByListingId(
    actor: AuthorizedActor,
    listingId: string,
  ): Promise<InventoryItemDto> {
    try {
      return await this.request<InventoryItemDto>(
        `/inventory/by-listing/${encodeURIComponent(listingId)}`,
        'GET',
        undefined,
        actor,
      );
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof ForbiddenError) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpInventoryClient: getInventoryByListingId failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          listingId,
        });
        return this.fallbackService.getInventoryByListingId(actor, listingId);
      }
      throw err;
    }
  }

  async getAvailabilityByListingId(listingId: string): Promise<InventoryAvailabilityDto> {
    try {
      return await this.request<InventoryAvailabilityDto>(
        `/inventory/availability/${encodeURIComponent(listingId)}`,
        'GET',
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpInventoryClient: getAvailabilityByListingId failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          listingId,
        });
        return this.fallbackService.getAvailabilityByListingId(listingId);
      }
      throw err;
    }
  }

  async increaseStock(
    actor: AuthorizedActor,
    inventoryId: string,
    quantity: number,
    notes?: string,
    referenceId?: string,
  ): Promise<InventoryItemDto> {
    try {
      return await this.request<InventoryItemDto>(
        `/inventory/${encodeURIComponent(inventoryId)}/stock/increase`,
        'POST',
        { quantity, notes, referenceId },
        actor,
      );
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof ForbiddenError ||
        err instanceof ValidationError ||
        err instanceof ConflictError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpInventoryClient: increaseStock failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          inventoryId,
        });
        return this.fallbackService.increaseStock(actor, inventoryId, quantity, notes, referenceId);
      }
      throw err;
    }
  }

  async decreaseStock(
    actor: AuthorizedActor,
    inventoryId: string,
    quantity: number,
    notes?: string,
  ): Promise<InventoryItemDto> {
    try {
      return await this.request<InventoryItemDto>(
        `/inventory/${encodeURIComponent(inventoryId)}/stock/decrease`,
        'POST',
        { quantity, notes },
        actor,
      );
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof ForbiddenError ||
        err instanceof ValidationError ||
        err instanceof InsufficientInventoryError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpInventoryClient: decreaseStock failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          inventoryId,
        });
        return this.fallbackService.decreaseStock(actor, inventoryId, quantity, notes);
      }
      throw err;
    }
  }

  async adjustNonSellable(
    actor: AuthorizedActor,
    inventoryId: string,
    newNonSellableQuantity: number,
    notes?: string,
    referenceId?: string,
  ): Promise<InventoryItemDto> {
    try {
      return await this.request<InventoryItemDto>(
        `/inventory/${encodeURIComponent(inventoryId)}/non-sellable`,
        'POST',
        { newNonSellableQuantity, notes, referenceId },
        actor,
      );
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof ForbiddenError ||
        err instanceof ValidationError ||
        err instanceof InsufficientInventoryError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpInventoryClient: adjustNonSellable failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          inventoryId,
        });
        return this.fallbackService.adjustNonSellable(
          actor,
          inventoryId,
          newNonSellableQuantity,
          notes,
          referenceId,
        );
      }
      throw err;
    }
  }

  async createReservation(
    actor: AuthorizedActor,
    input: CreateReservationInput,
  ): Promise<InventoryReservationDto> {
    try {
      return await this.request<InventoryReservationDto>(
        '/inventory/reservations',
        'POST',
        input,
        actor,
      );
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof ForbiddenError ||
        err instanceof ValidationError ||
        err instanceof InsufficientInventoryError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpInventoryClient: createReservation failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
        });
        return this.fallbackService.createReservation(actor, input);
      }
      throw err;
    }
  }

  async getReservationById(
    actor: AuthorizedActor,
    id: string,
  ): Promise<InventoryReservationDto> {
    try {
      return await this.request<InventoryReservationDto>(
        `/inventory/reservations/${encodeURIComponent(id)}`,
        'GET',
        undefined,
        actor,
      );
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof ForbiddenError) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpInventoryClient: getReservationById failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          id,
        });
        return this.fallbackService.getReservationById(actor, id);
      }
      throw err;
    }
  }

  async findReservationByIdempotencyKey(
    actor: AuthorizedActor,
    idempotencyKey: string,
  ): Promise<InventoryReservationDto | null> {
    try {
      const result = await this.request<{ reservation: InventoryReservationDto | null } | InventoryReservationDto | null>(
        `/inventory/reservations/by-idempotency/${encodeURIComponent(idempotencyKey)}`,
        'GET',
        undefined,
        actor,
      );
      if (!result) return null;
      if ('reservation' in (result as Record<string, unknown>)) {
        return (result as { reservation: InventoryReservationDto | null }).reservation;
      }
      return result as InventoryReservationDto;
    } catch (err) {
      if (err instanceof NotFoundError) {
        return null;
      }
      if (this.fallbackService) {
        this.logger?.warn(
          'HttpInventoryClient: findReservationByIdempotencyKey failed, falling back',
          {
            error: err instanceof Error ? err.message : 'unknown',
            idempotencyKey,
          },
        );
        return this.fallbackService.findReservationByIdempotencyKey(actor, idempotencyKey);
      }
      throw err;
    }
  }

  async releaseReservation(
    actor: AuthorizedActor,
    id: string,
    notes?: string,
  ): Promise<InventoryReservationDto> {
    try {
      return await this.request<InventoryReservationDto>(
        `/inventory/reservations/${encodeURIComponent(id)}/release`,
        'POST',
        { notes },
        actor,
      );
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof ForbiddenError ||
        err instanceof InvalidStateTransitionError ||
        err instanceof ConflictError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpInventoryClient: releaseReservation failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          id,
        });
        return this.fallbackService.releaseReservation(actor, id, notes);
      }
      throw err;
    }
  }

  async consumeReservation(
    actor: AuthorizedActor,
    id: string,
    notes?: string,
  ): Promise<InventoryReservationDto> {
    try {
      return await this.request<InventoryReservationDto>(
        `/inventory/reservations/${encodeURIComponent(id)}/consume`,
        'POST',
        { notes },
        actor,
      );
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof ForbiddenError ||
        err instanceof InvalidStateTransitionError ||
        err instanceof ConflictError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpInventoryClient: consumeReservation failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          id,
        });
        return this.fallbackService.consumeReservation(actor, id, notes);
      }
      throw err;
    }
  }

  async expireReservation(id: string, notes?: string): Promise<InventoryReservationDto> {
    try {
      return await this.request<InventoryReservationDto>(
        `/inventory/reservations/${encodeURIComponent(id)}/expire`,
        'POST',
        { notes },
      );
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof InvalidStateTransitionError ||
        err instanceof ConflictError
      ) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpInventoryClient: expireReservation failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          id,
        });
        return this.fallbackService.expireReservation(id, notes);
      }
      throw err;
    }
  }

  async processExpirations(batchSize?: number): Promise<number> {
    try {
      const res = await this.request<{ processedCount: number }>(
        '/inventory/reservations/process-expirations',
        'POST',
        { batchSize },
      );
      return res.processedCount;
    } catch (err) {
      if (this.fallbackService) {
        this.logger?.warn('HttpInventoryClient: processExpirations failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
        });
        return this.fallbackService.processExpirations(batchSize);
      }
      throw err;
    }
  }

  async getMovements(
    actor: AuthorizedActor,
    inventoryId: string,
  ): Promise<InventoryMovementDto[]> {
    try {
      return await this.request<InventoryMovementDto[]>(
        `/inventory/${encodeURIComponent(inventoryId)}/movements`,
        'GET',
        undefined,
        actor,
      );
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof ForbiddenError) {
        throw err;
      }
      if (this.fallbackService) {
        this.logger?.warn('HttpInventoryClient: getMovements failed, falling back', {
          error: err instanceof Error ? err.message : 'unknown',
          inventoryId,
        });
        return this.fallbackService.getMovements(actor, inventoryId);
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
        if (msg.toLowerCase().includes('insufficient')) {
          throw new InsufficientInventoryError(msg);
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
          `Inventory service responded with HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
        );
      }

      return (await response.json()) as T;
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof ValidationError ||
        err instanceof ForbiddenError ||
        err instanceof ConflictError ||
        err instanceof InsufficientInventoryError ||
        err instanceof InvalidStateTransitionError ||
        err instanceof ExternalServiceError
      ) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort') || message.includes('timeout')) {
        throw new ExternalServiceError(
          `Inventory service request timed out after ${this.timeoutMs}ms: ${path}`,
        );
      }
      throw new ExternalServiceError(`Failed to communicate with inventory service: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  startExpirationWorker?(_intervalMs?: number): void {}
  stopExpirationWorker?(): void {}
}

