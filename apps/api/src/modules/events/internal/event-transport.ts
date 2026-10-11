import type { DomainEvent } from './event-envelope.js';

export type EventHandler<T = unknown> = (event: DomainEvent<T>) => Promise<void>;

export interface EventTransport {
  publish(event: DomainEvent): Promise<void>;
  subscribe<T = unknown>(eventType: string, handler: EventHandler<T>): void;
  unsubscribe<T = unknown>(eventType: string, handler: EventHandler<T>): void;
}

/**
 * Provider-Neutral In-Memory Event Transport.
 * DEVELOPMENT & TESTING ADAPTER ONLY:
 * Used when no external distributed broker (Kafka, RabbitMQ, SNS/SQS) is configured.
 */
export class InMemoryEventTransport implements EventTransport {
  private readonly subscribers = new Map<string, Set<EventHandler<unknown>>>();
  private readonly publishedEvents: DomainEvent[] = [];
  private simulateFailure = false;
  private simulateDuplicate = false;

  setSimulateFailure(fail: boolean): void {
    this.simulateFailure = fail;
  }

  setSimulateDuplicate(duplicate: boolean): void {
    this.simulateDuplicate = duplicate;
  }

  getPublishedEvents(): DomainEvent[] {
    return [...this.publishedEvents];
  }

  clear(): void {
    this.publishedEvents.length = 0;
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
    if (this.simulateFailure) {
      throw new Error('Event transport connection dropped (simulated outage)');
    }

    this.publishedEvents.push(event);

    const errors: unknown[] = [];

    const handlers = this.subscribers.get(event.eventType);
    if (handlers && handlers.size > 0) {
      for (const handler of handlers) {
        try {
          await handler(event);

          // If duplicate delivery simulation is enabled, dispatch the event a second time
          if (this.simulateDuplicate) {
            await handler(event);
          }
        } catch (err) {
          errors.push(err);
        }
      }
    }

    // Also dispatch to wildcard subscribers ('*')
    const wildcardHandlers = this.subscribers.get('*');
    if (wildcardHandlers && wildcardHandlers.size > 0) {
      for (const handler of wildcardHandlers) {
        try {
          await handler(event);
          if (this.simulateDuplicate) {
            await handler(event);
          }
        } catch (err) {
          errors.push(err);
        }
      }
    }

    if (errors.length > 0) {
      if (errors.length === 1) {
        throw errors[0];
      }
      throw new AggregateError(
        errors,
        `Multiple event subscribers failed during dispatch of '${event.eventType}'`,
      );
    }
  }
}
