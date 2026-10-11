import type { DomainEvent } from './event-envelope.js';
import type { EventTransport, EventHandler } from './event-transport.js';
import type { Logger } from '../../../observability/logger.js';
import { ExternalServiceError } from '../../../errors/app-error.js';

export interface HttpEventTransportOptions {
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  fallbackTransport?: EventTransport | undefined;
  logger?: Logger | undefined;
}

/**
 * HttpEventTransport - Remote Distributed Event Broker Transport.
 *
 * Implements EventTransport to dispatch domain events over HTTP to a standalone event-broker-service.
 */
export class HttpEventTransport implements EventTransport {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallbackTransport?: EventTransport | undefined;
  private readonly logger?: Logger | undefined;
  private readonly subscribers = new Map<string, Set<EventHandler<unknown>>>();

  constructor(serviceUrl: string, options: HttpEventTransportOptions = {}) {
    this.baseUrl = serviceUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.fallbackTransport = options.fallbackTransport;
    this.logger = options.logger;
  }

  getFallbackTransport(): EventTransport | undefined {
    return this.fallbackTransport;
  }

  subscribe<T = unknown>(eventType: string, handler: EventHandler<T>): void {
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, new Set());
    }
    this.subscribers.get(eventType)!.add(handler as EventHandler<unknown>);
  }

  unsubscribe<T = unknown>(eventType: string, handler: EventHandler<T>): void {
    const handlers = this.subscribers.get(eventType);
    if (handlers) {
      handlers.delete(handler as EventHandler<unknown>);
    }
  }

  async publish(event: DomainEvent): Promise<void> {
    const url = `${this.baseUrl}/events/publish`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-event-id': event.eventId,
          'x-event-type': event.eventType,
          'x-tenant-id': event.tenantId,
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new ExternalServiceError(
          `Event broker HTTP ${response.status}: ${errorText}`,
          'EVENT_BROKER_PUBLISH_FAILED',
        );
      }
    } catch (err) {
      if (this.fallbackTransport && this.isFallbackEligible(err)) {
        this.logger?.warn('Remote event broker transport failed; falling back to local transport', {
          error: (err as Error).message,
          eventId: event.eventId,
          eventType: event.eventType,
        });
        return this.fallbackTransport.publish(event);
      }

      if (err instanceof Error && err.name === 'AbortError') {
        throw new ExternalServiceError(
          `Event broker request timed out after ${this.timeoutMs}ms`,
          'EVENT_BROKER_TIMEOUT',
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
}
