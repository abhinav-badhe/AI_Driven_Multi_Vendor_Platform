import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type { DomainEvent } from './event-envelope.js';
import type {
  IOutboxService,
  OutboxEventRecord,
  PublishOptions,
  PublishResult,
  ListOutboxEventsFilter,
} from './event-models.js';
import type { EventTransport } from './event-transport.js';
import { ForbiddenError, NotFoundError } from '../../../errors/app-error.js';

/**
 * InMemoryOutboxStore - Zero-DB in-memory outbox store for unit tests, offline resilience, and HTTP fallback.
 */
export class InMemoryOutboxStore implements IOutboxService {
  private readonly events = new Map<string, OutboxEventRecord>();
  private readonly receipts = new Map<string, string[]>(); // consumerName -> eventIds

  constructor(private readonly transport?: EventTransport) {}

  async recordEvent(_tx: unknown, event: DomainEvent): Promise<void> {
    const now = new Date().toISOString();
    const record: OutboxEventRecord = {
      eventId: event.eventId,
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      tenantId: event.tenantId,
      occurredAt: event.occurredAt,
      payload: event.payload as Record<string, unknown>,
      metadata: event.metadata as Record<string, unknown>,
      status: 'PENDING',
      attemptCount: 0,
      availableAt: now,
      leaseExpiresAt: null,
      publishedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.events.set(record.eventId, record);
  }

  async publishPendingEvents(options: PublishOptions = {}): Promise<PublishResult> {
    const batchSize = options.batchSize ?? 50;
    const pending = Array.from(this.events.values())
      .filter((e) => e.status === 'PENDING')
      .slice(0, batchSize);

    let publishedCount = 0;
    let failedCount = 0;

    for (const record of pending) {
      if (this.transport) {
        try {
          const domainEvent: DomainEvent = {
            eventId: record.eventId,
            eventType: record.eventType,
            eventVersion: record.eventVersion,
            aggregateType: record.aggregateType,
            aggregateId: record.aggregateId,
            tenantId: record.tenantId,
            occurredAt: record.occurredAt,
            payload: record.payload,
            metadata: record.metadata as DomainEvent['metadata'],
          };
          await this.transport.publish(domainEvent);
          record.status = 'PUBLISHED';
          record.publishedAt = new Date().toISOString();
          publishedCount++;
        } catch (err) {
          record.status = 'FAILED';
          record.lastError = err instanceof Error ? err.message : String(err);
          record.attemptCount++;
          failedCount++;
        }
      } else {
        record.status = 'PUBLISHED';
        record.publishedAt = new Date().toISOString();
        publishedCount++;
      }
      this.events.set(record.eventId, record);
    }

    return {
      claimedCount: pending.length,
      publishedCount,
      failedCount,
      deadLetteredCount: 0,
    };
  }

  async getEventById(actor: AuthorizedActor, eventId: string): Promise<OutboxEventRecord> {
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can inspect outbox events');
    }

    const record = this.events.get(eventId);
    if (!record) {
      throw new NotFoundError(`Outbox event with ID '${eventId}' was not found`);
    }
    return record;
  }

  async listEvents(
    actor: AuthorizedActor,
    filter?: ListOutboxEventsFilter,
  ): Promise<{ items: OutboxEventRecord[]; total: number }> {
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can list outbox events');
    }

    let items = Array.from(this.events.values());
    if (filter?.status) {
      items = items.filter((e) => e.status === filter.status);
    }
    if (filter?.tenantId) {
      items = items.filter((e) => e.tenantId === filter.tenantId);
    }
    if (filter?.eventType) {
      items = items.filter((e) => e.eventType === filter.eventType);
    }

    const total = items.length;
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 50;

    return {
      items: items.slice(offset, offset + limit),
      total,
    };
  }

  async replayEvent(actor: AuthorizedActor, eventId: string): Promise<{ replayed: boolean }> {
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can replay outbox events');
    }

    const record = this.events.get(eventId);
    if (!record) {
      throw new NotFoundError(
        `Event '${eventId}' not found or not in eligible failure/dead-letter status for replay`,
      );
    }

    record.status = 'PENDING';
    record.attemptCount = 0;
    record.lastError = null;
    record.updatedAt = new Date().toISOString();
    this.events.set(eventId, record);
    return { replayed: true };
  }

  async resetConsumerReceipts(
    actor: AuthorizedActor,
    consumerName: string,
  ): Promise<{ clearedCount: number }> {
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators may reset consumer receipts');
    }

    const existing = this.receipts.get(consumerName) ?? [];
    const clearedCount = existing.length;
    this.receipts.set(consumerName, []);
    return { clearedCount };
  }

  // Testing helpers
  seedEvent(record: OutboxEventRecord): void {
    this.events.set(record.eventId, record);
  }

  clear(): void {
    this.events.clear();
    this.receipts.clear();
  }
}
