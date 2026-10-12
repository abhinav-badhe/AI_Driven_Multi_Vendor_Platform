import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type { DomainEvent } from './event-envelope.js';
import type {
  IOutboxService,
  OutboxEventRecord,
  PublishOptions,
  PublishResult,
  ListOutboxEventsFilter,
} from './event-models.js';
import type { Logger } from '../../../observability/logger.js';
import {
  ExternalServiceError,
  NotFoundError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
  ConflictError,
} from '../../../errors/app-error.js';

export interface HttpOutboxClientOptions {
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  fallbackService?: IOutboxService | undefined;
  logger?: Logger | undefined;
}

/**
 * HttpOutboxClient - Remote Outbox & Events Microservice HTTP Client.
 *
 * Implements IOutboxService to query outbox ledger entries, trigger outbox processing,
 * and execute administrative event replay over HTTP against a standalone event broker service.
 */
export class HttpOutboxClient implements IOutboxService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallbackService?: IOutboxService | undefined;
  private readonly logger?: Logger | undefined;

  constructor(serviceUrl: string, options: HttpOutboxClientOptions = {}) {
    this.baseUrl = serviceUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.fallbackService = options.fallbackService;
    this.logger = options.logger;
  }

  getFallbackService(): IOutboxService | undefined {
    return this.fallbackService;
  }

  async recordEvent(tx: DatabaseConnection | unknown, event: DomainEvent): Promise<void> {
    if (this.fallbackService) {
      return this.fallbackService.recordEvent(tx, event);
    }
    // Remote broker event publish
    try {
      await this.request<void>('POST', '/events/outbox/record', undefined, event);
    } catch (err) {
      this.logger?.warn('Failed to record event to remote outbox service', {
        error: (err as Error).message,
        eventId: event.eventId,
      });
      throw err;
    }
  }

  async listEvents(
    actor: AuthorizedActor,
    filter?: ListOutboxEventsFilter,
  ): Promise<{ items: OutboxEventRecord[]; total: number }> {
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    if (filter?.tenantId) params.set('tenantId', filter.tenantId);
    if (filter?.eventType) params.set('eventType', filter.eventType);
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter?.offset !== undefined) params.set('offset', String(filter.offset));
    const query = params.toString() ? `?${params.toString()}` : '';

    try {
      return await this.request<{ items: OutboxEventRecord[]; total: number }>(
        'GET',
        `/events/outbox${query}`,
        actor,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote outbox service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.listEvents(actor, filter);
      }
      throw err;
    }
  }

  async getEventById(actor: AuthorizedActor, eventId: string): Promise<OutboxEventRecord> {
    try {
      return await this.request<OutboxEventRecord>(
        'GET',
        `/events/outbox/${encodeURIComponent(eventId)}`,
        actor,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote outbox service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.getEventById(actor, eventId);
      }
      throw err;
    }
  }

  async replayEvent(actor: AuthorizedActor, eventId: string): Promise<{ replayed: boolean }> {
    try {
      return await this.request<{ replayed: boolean }>(
        'POST',
        `/events/outbox/${encodeURIComponent(eventId)}/replay`,
        actor,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote outbox service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.replayEvent(actor, eventId);
      }
      throw err;
    }
  }

  async publishPendingEvents(options: PublishOptions = {}): Promise<PublishResult> {
    try {
      return await this.request<PublishResult>(
        'POST',
        '/events/outbox/process',
        undefined,
        options,
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote outbox service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.publishPendingEvents(options);
      }
      throw err;
    }
  }

  async resetConsumerReceipts(
    actor: AuthorizedActor,
    consumerName: string,
  ): Promise<{ clearedCount: number }> {
    try {
      return await this.request<{ clearedCount: number }>(
        'POST',
        '/events/outbox/receipts/reset',
        actor,
        { consumerName },
      );
    } catch (err) {
      if (this.fallbackService && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote outbox service failed; falling back to local service', {
          error: (err as Error).message,
        });
        return this.fallbackService.resetConsumerReceipts(actor, consumerName);
      }
      throw err;
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

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        return (await response.json()) as T;
      }
      return undefined as unknown as T;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ExternalServiceError(
          `Outbox service request timed out after ${this.timeoutMs}ms`,
          'OUTBOX_SERVICE_TIMEOUT',
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
      throw new ConflictError(message);
    }
    throw new ExternalServiceError(
      `Remote outbox service returned HTTP ${status}: ${message}`,
      code || 'OUTBOX_SERVICE_ERROR',
    );
  }
}
