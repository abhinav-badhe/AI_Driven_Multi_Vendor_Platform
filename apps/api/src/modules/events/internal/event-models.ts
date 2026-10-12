import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type { DomainEvent } from './event-envelope.js';
import type { OutboxEventRecord, ConsumerReceiptRecord } from './outbox-repository.js';
import type { PublishOptions, PublishResult } from './outbox-service.js';

export type { OutboxEventRecord, ConsumerReceiptRecord, PublishOptions, PublishResult };

export interface ListOutboxEventsFilter {
  status?: string | undefined;
  tenantId?: string | undefined;
  eventType?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/**
 * IOutboxReader - Decoupled query interface for outbox events inspection.
 */
export interface IOutboxReader {
  getEventById(actor: AuthorizedActor, eventId: string): Promise<OutboxEventRecord>;
  listEvents(
    actor: AuthorizedActor,
    filter?: ListOutboxEventsFilter,
  ): Promise<{ items: OutboxEventRecord[]; total: number }>;
}

/**
 * IOutboxService - Transactional outbox event recording and lifecycle operations.
 * Implemented by OutboxService (SQL), InMemoryOutboxStore, and HttpOutboxClient.
 */
export interface IOutboxService extends IOutboxReader {
  recordEvent(tx: DatabaseConnection | unknown, event: DomainEvent): Promise<void>;
  publishPendingEvents(options?: PublishOptions): Promise<PublishResult>;
  replayEvent(actor: AuthorizedActor, eventId: string): Promise<{ replayed: boolean }>;
  resetConsumerReceipts(
    actor: AuthorizedActor,
    consumerName: string,
  ): Promise<{ clearedCount: number }>;
}
