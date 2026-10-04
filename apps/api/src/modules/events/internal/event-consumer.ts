import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { DomainEvent } from './event-envelope.js';
import { isEventVersionSupported } from './event-envelope.js';
import type { EventTransport } from './event-transport.js';
import { OutboxRepository } from './outbox-repository.js';

export interface ConsumerExecutionResult {
  handled: boolean;
  duplicate: boolean;
  quarantined: boolean;
  error?: string;
}

export abstract class BaseEventConsumer<TPayload = Record<string, unknown>> {
  constructor(
    public readonly consumerName: string,
    protected readonly db: DatabaseConnection,
    protected readonly outboxRepo: OutboxRepository,
    protected readonly transport: EventTransport,
    protected readonly logger: Logger,
  ) {}

  /**
   * Subscribe to specific event types on the configured transport.
   */
  abstract registerSubscriptions(): void;

  /**
   * The domain-specific event handling logic.
   */
  protected abstract handleEvent(event: DomainEvent<TPayload>): Promise<void>;

  /**
   * Governed, idempotent execution pipeline:
   * 1. Checks schema version compatibility (quarantines unsupported versions).
   * 2. Checks database consumer receipt table with UNIQUE(consumer_name, event_id).
   * 3. Prevents duplicate processing across retries, crashes, or re-deliveries.
   * 4. Dispatches to domain handler.
   * 5. Atomically records completion status.
   */
  async process(event: DomainEvent<unknown>): Promise<ConsumerExecutionResult> {
    const typedEvent = event as DomainEvent<TPayload>;
    const { eventId, eventType, eventVersion } = event;

    // 1. Schema Version Compatibility Check
    if (!isEventVersionSupported(eventType, eventVersion)) {
      this.logger.error('Unsupported event schema version; event quarantined', {
        consumerName: this.consumerName,
        eventId,
        eventType,
        eventVersion,
      });

      try {
        await this.outboxRepo.recordReceipt(this.db, {
          id: randomUUID(),
          consumerName: this.consumerName,
          eventId,
          status: 'QUARANTINED',
          errorMetadata: {
            reason: `Unsupported event schema version '${eventVersion}' for '${eventType}'`,
          },
        });
      } catch {
        // Receipt might already exist
      }

      return { handled: false, duplicate: false, quarantined: true };
    }

    // 2. Durable Idempotency Check: Check if already processed
    const existing = await this.outboxRepo.findReceipt(this.db, this.consumerName, eventId);
    if (existing) {
      if (existing.status === 'COMPLETED' || existing.status === 'PROCESSING') {
        this.logger.info('Duplicate event delivery detected and safely deduplicated', {
          consumerName: this.consumerName,
          eventId,
          eventType,
          priorStatus: existing.status,
          processedAt: existing.processedAt,
        });
        return { handled: false, duplicate: true, quarantined: false };
      }
    }

    // 3. Atomically Claim Receipt
    const receiptId = randomUUID();
    let claimSuccessful = false;

    try {
      await this.db.withTransaction(async (tx) => {
        await this.outboxRepo.recordReceipt(tx, {
          id: receiptId,
          consumerName: this.consumerName,
          eventId,
          status: 'PROCESSING',
        });
      });
      claimSuccessful = true;
    } catch {
      // UNIQUE constraint violation: concurrent delivery attempt already claimed or processed this event!
      this.logger.info('Concurrent duplicate event receipt claimed by sibling worker; skipping', {
        consumerName: this.consumerName,
        eventId,
      });
      return { handled: false, duplicate: true, quarantined: false };
    }

    if (!claimSuccessful) {
      return { handled: false, duplicate: true, quarantined: false };
    }

    // 4. Execute Domain Handler
    try {
      await this.handleEvent(typedEvent);

      await this.outboxRepo.updateReceiptStatus(
        this.db,
        this.consumerName,
        eventId,
        'COMPLETED',
      );

      this.logger.info('Event successfully processed by consumer', {
        consumerName: this.consumerName,
        eventId,
        eventType,
        aggregateId: event.aggregateId,
        tenantId: event.tenantId,
        correlationId: event.metadata.correlationId,
      });

      return { handled: true, duplicate: false, quarantined: false };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      await this.outboxRepo.updateReceiptStatus(
        this.db,
        this.consumerName,
        eventId,
        'FAILED',
        { error: errorMessage },
      );

      this.logger.error('Consumer event handler failed', {
        consumerName: this.consumerName,
        eventId,
        eventType,
        error: errorMessage,
      });

      return { handled: false, duplicate: false, quarantined: false, error: errorMessage };
    }
  }
}
