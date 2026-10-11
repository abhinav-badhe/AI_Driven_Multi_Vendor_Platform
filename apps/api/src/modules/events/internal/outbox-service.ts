import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { AuthorizedActor } from '../../identity/index.js';
import { ForbiddenError, NotFoundError } from '../../../errors/app-error.js';
import type { DomainEvent } from './event-envelope.js';
import type { EventTransport } from './event-transport.js';
import { OutboxRepository, type OutboxEventRecord } from './outbox-repository.js';

export interface PublishOptions {
  batchSize?: number;
  leaseDurationMs?: number;
  maxAttempts?: number;
  baseRetryDelayMs?: number;
}

export interface PublishResult {
  claimedCount: number;
  publishedCount: number;
  failedCount: number;
  deadLetteredCount: number;
}

import type { IOutboxService } from './event-models.js';

export class OutboxService implements IOutboxService {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly outboxRepo: OutboxRepository,
    private readonly transport: EventTransport,
    private readonly logger: Logger,
  ) {}

  /**
   * CRITICAL TRANSACTIONAL ATOMICITY CONTRACT:
   * Records a domain event into the durable outbox table inside the caller's active database transaction.
   * If the domain transaction commits, the event is guaranteed to persist.
   * If the domain transaction rolls back, the event is rolled back.
   *
   * @param tx - The active PostgreSQL client transaction
   * @param event - The typed, validated domain event envelope
   */
  async recordEvent(tx: DatabaseConnection, event: DomainEvent): Promise<void> {
    await this.outboxRepo.insertEvent(tx, event);

    this.logger.info('Outbox event recorded atomically with domain transaction', {
      eventId: event.eventId,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      tenantId: event.tenantId,
      correlationId: event.metadata.correlationId,
      causationId: event.metadata.causationId,
    });
  }

  /**
   * Processes a batch of pending or expired-lease outbox events and dispatches them to the configured transport.
   * Uses row-level lock/lease claiming to ensure multiple concurrent workers do not dispatch the same event.
   */
  async publishPendingEvents(options: PublishOptions = {}): Promise<PublishResult> {
    const batchSize = options.batchSize ?? 50;
    const leaseDurationMs = options.leaseDurationMs ?? 30000; // 30s lease default
    const maxAttempts = options.maxAttempts ?? 3;
    const baseRetryDelayMs = options.baseRetryDelayMs ?? 1000;

    const claimed = await this.outboxRepo.claimBatch(this.db, batchSize, leaseDurationMs);

    let publishedCount = 0;
    let failedCount = 0;
    let deadLetteredCount = 0;

    for (const record of claimed) {
      const event: DomainEvent = {
        eventId: record.eventId,
        eventType: record.eventType,
        eventVersion: record.eventVersion,
        aggregateType: record.aggregateType,
        aggregateId: record.aggregateId,
        tenantId: record.tenantId,
        occurredAt: record.occurredAt,
        payload: record.payload,
        metadata: record.metadata,
      };

      try {
        await this.transport.publish(event);
        await this.outboxRepo.markPublished(this.db, record.eventId);
        publishedCount += 1;

        this.logger.info('Outbox event published to transport', {
          eventId: record.eventId,
          eventType: record.eventType,
          aggregateId: record.aggregateId,
          tenantId: record.tenantId,
          correlationId: event.metadata.correlationId,
          causationId: event.metadata.causationId,
          attemptCount: record.attemptCount,
        });
      } catch (err: unknown) {
        failedCount += 1;
        const errorMessage = err instanceof Error ? err.message : String(err);
        const nextAttempt = record.attemptCount;
        const isDeadLetter = nextAttempt >= maxAttempts;

        if (isDeadLetter) {
          deadLetteredCount += 1;
          await this.outboxRepo.recordFailure(this.db, record.eventId, errorMessage, null, true);

          this.logger.error('Outbox event exceeded max retry attempts and was dead-lettered', {
            eventId: record.eventId,
            eventType: record.eventType,
            aggregateId: record.aggregateId,
            tenantId: record.tenantId,
            correlationId: event.metadata.correlationId,
            attemptCount: nextAttempt,
            error: errorMessage,
          });
        } else {
          const delayMs = baseRetryDelayMs * Math.pow(2, nextAttempt - 1);
          const nextAvailableAt = new Date(Date.now() + delayMs);
          await this.outboxRepo.recordFailure(
            this.db,
            record.eventId,
            errorMessage,
            nextAvailableAt,
            false,
          );

          this.logger.warn('Outbox event publish failed, scheduled for retry', {
            eventId: record.eventId,
            eventType: record.eventType,
            aggregateId: record.aggregateId,
            tenantId: record.tenantId,
            correlationId: event.metadata.correlationId,
            attemptCount: nextAttempt,
            nextAvailableAt: nextAvailableAt.toISOString(),
            error: errorMessage,
          });
        }
      }
    }

    return {
      claimedCount: claimed.length,
      publishedCount,
      failedCount,
      deadLetteredCount,
    };
  }

  // --- Administrative Governance Operations ---

  async getEventById(
    actor: AuthorizedActor,
    eventId: string,
  ): Promise<OutboxEventRecord> {
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can inspect outbox events');
    }

    const event = await this.outboxRepo.getEventById(this.db, eventId);
    if (!event) {
      throw new NotFoundError(`Outbox event with ID '${eventId}' was not found`);
    }
    return event;
  }

  async listEvents(
    actor: AuthorizedActor,
    filter: {
      status?: string | undefined;
      tenantId?: string | undefined;
      eventType?: string | undefined;
      limit?: number | undefined;
      offset?: number | undefined;
    } = {},
  ): Promise<{ items: OutboxEventRecord[]; total: number }> {
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can list outbox events');
    }

    return this.outboxRepo.listEvents(this.db, filter);
  }

  async replayEvent(
    actor: AuthorizedActor,
    eventId: string,
  ): Promise<{ replayed: boolean }> {
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can replay outbox events');
    }

    const replayed = await this.outboxRepo.replayEvent(this.db, eventId);
    if (!replayed) {
      throw new NotFoundError(
        `Event '${eventId}' not found or not in eligible failure/dead-letter status for replay`,
      );
    }

    this.logger.info('Outbox event reset for administrative replay', {
      eventId,
      adminUserId: actor.userId,
    });

    return { replayed: true };
  }

  /**
   * Resets consumer receipts for projection recovery, allowing replayed outbox events to be re-processed.
   */
  async resetConsumerReceipts(
    actor: AuthorizedActor,
    consumerName: string,
  ): Promise<{ clearedCount: number }> {
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators may reset consumer receipts');
    }

    const clearedCount = await this.outboxRepo.clearReceiptsForConsumer(this.db, consumerName);

    this.logger.info('Consumer receipts cleared for projection recovery', {
      consumerName,
      clearedCount,
      adminUserId: actor.userId,
    });

    return { clearedCount };
  }
}

