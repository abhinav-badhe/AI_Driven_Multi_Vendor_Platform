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

export interface ConsumerOptions {
  maxAttempts?: number;
  staleTimeoutMs?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

export interface ConsumerRetryOptions {
  batchSize?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  maxAttempts?: number;
  staleTimeoutMs?: number;
}

export interface ConsumerRetryResult {
  claimed: number;
  retried: number;
  succeeded: number;
  failed: number;
  quarantined: number;
}

/**
 * Checks whether an error is a PostgreSQL unique constraint violation (code 23505).
 * Inspects both standard PG error code '23505' and common unique-constraint error strings.
 */
export function isUniqueConstraintViolation(err: unknown): boolean {
  if (!err) return false;
  if ((err as { code?: string }).code === '23505') return true;
  if (
    err instanceof Error &&
    (err.message.includes('unique constraint') ||
      err.message.includes('23505') ||
      err.message.includes('duplicate key') ||
      err.message.includes('uq_consumer_event_receipt'))
  ) {
    return true;
  }
  return false;
}

export abstract class BaseEventConsumer<TPayload = Record<string, unknown>> {
  public readonly maxAttempts: number;
  public readonly staleTimeoutMs: number;
  public readonly baseRetryDelayMs: number;
  public readonly maxRetryDelayMs: number;

  constructor(
    public readonly consumerName: string,
    protected readonly db: DatabaseConnection,
    protected readonly outboxRepo: OutboxRepository,
    protected readonly transport: EventTransport,
    protected readonly logger: Logger,
    options?: ConsumerOptions,
  ) {
    this.maxAttempts = options?.maxAttempts ?? 5;
    this.staleTimeoutMs = options?.staleTimeoutMs ?? 60_000;
    this.baseRetryDelayMs = options?.baseRetryDelayMs ?? 2_000;
    this.maxRetryDelayMs = options?.maxRetryDelayMs ?? 300_000;
  }

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
   * 2. Safely claims receipt using atomic INSERT into event_consumer_receipts with claimToken.
   * 3. On 23505 unique constraint violation: inspects existing receipt state.
   *    - Reclaims FAILED or stale PROCESSING receipts using atomic CAS.
   *    - Fences completion and failure updates using claimToken.
   *    - Re-throws non-23505 database infrastructure errors.
   * 4. Dispatches to domain handler.
   * 5. Atomically records completion status fenced by claimToken.
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
            quarantinedAt: new Date().toISOString(),
          },
        });
      } catch (err: unknown) {
        if (!isUniqueConstraintViolation(err)) {
          throw err;
        }
      }

      return { handled: false, duplicate: false, quarantined: true };
    }

    const claimToken = randomUUID();
    let claimed = false;
    let currentAttempts = 1;

    // 2. Attempt initial INSERT with status='PROCESSING' and claimToken fencing
    const receiptId = randomUUID();
    try {
      await this.db.query(
        `INSERT INTO event_consumer_receipts (
          id, consumer_name, event_id, status, error_metadata, processed_at, created_at
        ) VALUES ($1, $2, $3, 'PROCESSING', $4, NOW(), NOW())`,
        [
          receiptId,
          this.consumerName,
          eventId,
          JSON.stringify({
            claimToken,
            attempts: 1,
            claimedAt: new Date().toISOString(),
          }),
        ],
      );
      claimed = true;
      currentAttempts = 1;
    } catch (err: unknown) {
      if (!isUniqueConstraintViolation(err)) {
        // Infrastructure / database error: must propagate rather than misclassifying as duplicate!
        this.logger.error('Database infrastructure error during consumer receipt creation', {
          consumerName: this.consumerName,
          eventId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      // UNIQUE constraint violation: receipt already exists; inspect state below
    }

    // 3. If initial insertion conflicted (23505), inspect state and attempt atomic CAS reclaim
    if (!claimed) {
      const existing = await this.outboxRepo.findReceipt(this.db, this.consumerName, eventId);
      if (!existing) {
        return { handled: false, duplicate: true, quarantined: false };
      }

      if (existing.status === 'COMPLETED' || existing.status === 'SKIPPED') {
        this.logger.info('Duplicate event delivery detected and safely deduplicated', {
          consumerName: this.consumerName,
          eventId,
          eventType,
          priorStatus: existing.status,
          processedAt: existing.processedAt,
        });
        return { handled: false, duplicate: true, quarantined: false };
      }

      if (existing.status === 'QUARANTINED') {
        this.logger.warn('Event delivery skipped; event already quarantined', {
          consumerName: this.consumerName,
          eventId,
          eventType,
        });
        return { handled: false, duplicate: false, quarantined: true };
      }

      const errMeta = existing.errorMetadata ?? {};
      const priorAttempts =
        typeof errMeta.attempts === 'number' &&
        Number.isInteger(errMeta.attempts) &&
        errMeta.attempts > 0
          ? errMeta.attempts
          : 1;

      if (existing.status === 'PROCESSING') {
        const processedTime = new Date(existing.processedAt).getTime();
        const isStale = Date.now() - processedTime > this.staleTimeoutMs;
        if (!isStale) {
          this.logger.info('Duplicate event delivery skipped: active worker currently processing', {
            consumerName: this.consumerName,
            eventId,
            eventType,
            claimedAt: existing.processedAt,
          });
          return { handled: false, duplicate: true, quarantined: false };
        }
      }

      // If attempts already reached or exceeded limit, mark QUARANTINED
      if (priorAttempts >= this.maxAttempts) {
        const staleThreshold = new Date(Date.now() - this.staleTimeoutMs).toISOString();
        const qRes = await this.db.query(
          `UPDATE event_consumer_receipts
           SET status = 'QUARANTINED', processed_at = NOW(), error_metadata = $3
           WHERE consumer_name = $1 AND event_id = $2
             AND (
               status = 'FAILED'
               OR (status = 'PROCESSING' AND processed_at <= $4)
             )`,
          [
            this.consumerName,
            eventId,
            JSON.stringify({
              ...errMeta,
              attempts: priorAttempts,
              quarantinedAt: new Date().toISOString(),
              reason: `Exceeded maximum retry attempts (${this.maxAttempts})`,
            }),
            staleThreshold,
          ],
        );

        if ((qRes.rowCount ?? 0) === 0) {
          // Lost race: another worker may have completed, claimed, or quarantined the receipt.
          const latest = await this.outboxRepo.findReceipt(this.db, this.consumerName, eventId);
          if (latest?.status === 'COMPLETED' || latest?.status === 'SKIPPED') {
            this.logger.info('Duplicate event delivery skipped: completed by concurrent worker', {
              consumerName: this.consumerName,
              eventId,
            });
            return { handled: false, duplicate: true, quarantined: false };
          }
          return {
            handled: false,
            duplicate: false,
            quarantined: latest?.status === 'QUARANTINED',
            error: `Exceeded maximum retry attempts (${this.maxAttempts})`,
          };
        }

        this.logger.error('Consumer event reached maximum attempts and was quarantined', {
          consumerName: this.consumerName,
          eventId,
          attempts: priorAttempts,
        });
        return {
          handled: false,
          duplicate: false,
          quarantined: true,
          error: `Exceeded maximum retry attempts (${this.maxAttempts})`,
        };
      }

      // Atomic CAS reclaim of FAILED or stale PROCESSING receipt
      const staleThreshold = new Date(Date.now() - this.staleTimeoutMs).toISOString();
      const nextAttempts = priorAttempts + 1;
      const reclaimRes = await this.db.query(
        `UPDATE event_consumer_receipts
         SET status = 'PROCESSING',
             processed_at = NOW(),
             error_metadata = $3
         WHERE consumer_name = $1 AND event_id = $2
           AND (
             status = 'FAILED'
             OR (status = 'PROCESSING' AND processed_at <= $4)
           )`,
        [
          this.consumerName,
          eventId,
          JSON.stringify({
            ...errMeta,
            claimToken,
            attempts: nextAttempts,
            claimedAt: new Date().toISOString(),
          }),
          staleThreshold,
        ],
      );

      if ((reclaimRes.rowCount ?? 0) === 0) {
        // Lost claim race to concurrent worker
        this.logger.info('Concurrent claim race lost to sibling worker; skipping', {
          consumerName: this.consumerName,
          eventId,
        });
        return { handled: false, duplicate: true, quarantined: false };
      }

      claimed = true;
      currentAttempts = nextAttempts;
    }

    if (!claimed) {
      return { handled: false, duplicate: true, quarantined: false };
    }

    // 4. Execute Domain Handler
    try {
      await this.handleEvent(typedEvent);

      // Complete with claimToken fencing so expired worker cannot overwrite newer claim
      const compRes = await this.db.query(
        `UPDATE event_consumer_receipts
         SET status = 'COMPLETED',
             processed_at = NOW(),
             error_metadata = NULL
         WHERE consumer_name = $1 AND event_id = $2
           AND status = 'PROCESSING'
           AND error_metadata->>'claimToken' = $3`,
        [this.consumerName, eventId, claimToken],
      );

      if ((compRes.rowCount ?? 0) === 0) {
        this.logger.warn('Consumer event handled, but claim token lease expired or was reclaimed', {
          consumerName: this.consumerName,
          eventId,
        });
        return { handled: false, duplicate: true, quarantined: false };
      }

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
      const isTerminal = currentAttempts >= this.maxAttempts;
      const finalStatus = isTerminal ? 'QUARANTINED' : 'FAILED';

      const backoffMultiplier = Math.pow(2, Math.min(Math.max(0, currentAttempts - 1), 8));
      const retryDelayMs = Math.min(
        this.baseRetryDelayMs * backoffMultiplier,
        this.maxRetryDelayMs,
      );
      const nextRetryAt = isTerminal ? null : new Date(Date.now() + retryDelayMs).toISOString();

      // Fenced failure update
      const failRes = await this.db.query(
        `UPDATE event_consumer_receipts
         SET status = $1,
             processed_at = NOW(),
             error_metadata = $2
         WHERE consumer_name = $3 AND event_id = $4
           AND status = 'PROCESSING'
           AND error_metadata->>'claimToken' = $5`,
        [
          finalStatus,
          JSON.stringify({
            attempts: currentAttempts,
            lastError: errorMessage,
            failedAt: new Date().toISOString(),
            ...(nextRetryAt ? { nextRetryAt } : {}),
            ...(isTerminal
              ? {
                  quarantinedAt: new Date().toISOString(),
                  reason: `Exceeded maximum retry attempts (${this.maxAttempts})`,
                }
              : {}),
          }),
          this.consumerName,
          eventId,
          claimToken,
        ],
      );

      if ((failRes.rowCount ?? 0) === 0) {
        this.logger.warn(
          'Consumer handler failed, but claim token lease expired or was overwritten',
          {
            consumerName: this.consumerName,
            eventId,
            error: errorMessage,
          },
        );
        const latest = await this.outboxRepo.findReceipt(this.db, this.consumerName, eventId);
        return {
          handled: false,
          duplicate: latest?.status === 'COMPLETED' || latest?.status === 'SKIPPED',
          quarantined: latest?.status === 'QUARANTINED',
          error: errorMessage,
        };
      } else {
        this.logger.error('Consumer event handler failed', {
          consumerName: this.consumerName,
          eventId,
          eventType,
          error: errorMessage,
          attempts: currentAttempts,
          status: finalStatus,
        });
      }

      return {
        handled: false,
        duplicate: false,
        quarantined: isTerminal,
        error: errorMessage,
      };
    }
  }

  /**
   * Retries failed or stale receipts belonging to this consumer.
   * Safe across multi-instance deployments using atomic CAS claims and exponential backoff.
   */
  async retryFailedEvents(options?: ConsumerRetryOptions): Promise<ConsumerRetryResult> {
    const batchSize = options?.batchSize ?? 50;
    const baseRetryDelayMs = options?.baseRetryDelayMs ?? this.baseRetryDelayMs;
    const maxRetryDelayMs = options?.maxRetryDelayMs ?? this.maxRetryDelayMs;
    const maxAttempts = options?.maxAttempts ?? this.maxAttempts;
    const staleTimeoutMs = options?.staleTimeoutMs ?? this.staleTimeoutMs;

    const nowIso = new Date().toISOString();
    const staleThreshold = new Date(Date.now() - staleTimeoutMs).toISOString();
    const ignoreBackoff = baseRetryDelayMs === 0;

    const res = await this.db.query<{
      receipt_id: string;
      event_id: string;
      receipt_status: string;
      error_metadata: Record<string, unknown> | string | null;
      receipt_processed_at: string | Date;
      event_type: string | null;
      event_version: number | null;
      aggregate_type: string | null;
      aggregate_id: string | null;
      tenant_id: string | null;
      occurred_at: string | Date | null;
      payload: Record<string, unknown> | string | null;
      metadata: Record<string, unknown> | string | null;
    }>(
      `SELECT r.id as receipt_id, r.event_id, r.status as receipt_status,
              r.error_metadata, r.processed_at as receipt_processed_at,
              e.event_type, e.event_version, e.aggregate_type, e.aggregate_id,
              e.tenant_id, e.occurred_at, e.payload, e.metadata
       FROM event_consumer_receipts r
       LEFT JOIN outbox_events e ON r.event_id = e.event_id
       WHERE r.consumer_name = $1
         AND (
           (
             r.status = 'FAILED'
             AND (
               $5 = true
               OR r.error_metadata->>'nextRetryAt' IS NULL
               OR r.error_metadata->>'nextRetryAt' <= $2
             )
           )
           OR (
             r.status = 'PROCESSING'
             AND r.processed_at <= $3
           )
         )
       ORDER BY r.processed_at ASC
       LIMIT $4`,
      [this.consumerName, nowIso, staleThreshold, batchSize, ignoreBackoff],
    );

    let claimed = 0;
    let retried = 0;
    let succeeded = 0;
    let failed = 0;
    let quarantined = 0;

    for (const row of res.rows) {
      let errMeta: Record<string, unknown> | null = null;
      try {
        errMeta =
          typeof row.error_metadata === 'string'
            ? JSON.parse(row.error_metadata)
            : row.error_metadata;
      } catch {
        errMeta = null;
      }

      const currentAttempts =
        errMeta &&
        typeof errMeta.attempts === 'number' &&
        Number.isInteger(errMeta.attempts) &&
        errMeta.attempts > 0
          ? errMeta.attempts
          : 1;

      // 1. Enforce max attempts
      if (currentAttempts >= maxAttempts) {
        const qRes = await this.db.query(
          `UPDATE event_consumer_receipts
           SET status = 'QUARANTINED', processed_at = NOW(), error_metadata = $3
           WHERE consumer_name = $1 AND event_id = $2
             AND (
               status = 'FAILED'
               OR (status = 'PROCESSING' AND processed_at <= $4)
             )`,
          [
            this.consumerName,
            row.event_id,
            JSON.stringify({
              ...errMeta,
              attempts: currentAttempts,
              quarantinedAt: new Date().toISOString(),
              reason: `Exceeded maximum retry attempts (${maxAttempts})`,
              lastError: errMeta?.lastError,
            }),
            staleThreshold,
          ],
        );
        if ((qRes.rowCount ?? 0) > 0) {
          quarantined++;
          this.logger.error('Consumer event retry exceeded max attempts and was quarantined', {
            consumerName: this.consumerName,
            eventId: row.event_id,
            attempts: currentAttempts,
          });
        }
        continue;
      }

      // 2. Exponential backoff check for FAILED receipts (compatibility with legacy receipts lacking nextRetryAt)
      if (row.receipt_status === 'FAILED') {
        let eligibleAt: number;
        if (errMeta?.nextRetryAt && typeof errMeta.nextRetryAt === 'string') {
          const parsedTime = new Date(errMeta.nextRetryAt).getTime();
          eligibleAt = Number.isNaN(parsedTime) ? 0 : parsedTime;
        } else {
          const backoffMultiplier = Math.pow(2, Math.min(Math.max(0, currentAttempts - 1), 8));
          const retryDelayMs = Math.min(baseRetryDelayMs * backoffMultiplier, maxRetryDelayMs);
          const failedAtTime = errMeta?.failedAt
            ? new Date(String(errMeta.failedAt)).getTime()
            : new Date(row.receipt_processed_at).getTime();
          const baseTime = Number.isNaN(failedAtTime)
            ? new Date(row.receipt_processed_at).getTime()
            : failedAtTime;
          eligibleAt = baseTime + retryDelayMs;
        }

        if (baseRetryDelayMs > 0 && Date.now() < eligibleAt) {
          continue; // Not yet eligible
        }
      }

      // 3. Ensure event exists in outbox
      if (!row.event_type) {
        const qRes = await this.db.query(
          `UPDATE event_consumer_receipts
           SET status = 'QUARANTINED', processed_at = NOW(), error_metadata = $3
           WHERE consumer_name = $1 AND event_id = $2
             AND (
               status = 'FAILED'
               OR (status = 'PROCESSING' AND processed_at <= $4)
             )`,
          [
            this.consumerName,
            row.event_id,
            JSON.stringify({
              ...errMeta,
              attempts: currentAttempts,
              quarantinedAt: new Date().toISOString(),
              reason: 'Event record not found in outbox_events table',
            }),
            staleThreshold,
          ],
        );
        if ((qRes.rowCount ?? 0) > 0) {
          quarantined++;
        }
        continue;
      }

      // 4. Atomic CAS claim with claimToken
      const claimToken = randomUUID();
      const nextAttempt = currentAttempts + 1;

      const claimRes = await this.db.query(
        `UPDATE event_consumer_receipts
         SET status = 'PROCESSING',
             processed_at = NOW(),
             error_metadata = $3
         WHERE consumer_name = $1 AND event_id = $2
           AND (
             status = 'FAILED'
             OR (status = 'PROCESSING' AND processed_at <= $4)
           )`,
        [
          this.consumerName,
          row.event_id,
          JSON.stringify({
            ...errMeta,
            claimToken,
            attempts: nextAttempt,
            claimedAt: new Date().toISOString(),
            lastError: errMeta?.lastError,
          }),
          staleThreshold,
        ],
      );

      if ((claimRes.rowCount ?? 0) === 0) {
        continue; // Lost race
      }

      claimed++;
      retried++;

      // 5. Parse payload and metadata safely
      let payload: Record<string, unknown>;
      let metadata: Record<string, unknown>;
      try {
        payload =
          typeof row.payload === 'string'
            ? JSON.parse(row.payload)
            : (row.payload as Record<string, unknown>);
        metadata =
          typeof row.metadata === 'string'
            ? JSON.parse(row.metadata)
            : (row.metadata as Record<string, unknown>);
      } catch (parseErr: unknown) {
        quarantined++;
        await this.db.query(
          `UPDATE event_consumer_receipts
           SET status = 'QUARANTINED', processed_at = NOW(), error_metadata = $3
           WHERE consumer_name = $1 AND event_id = $2
             AND status = 'PROCESSING' AND error_metadata->>'claimToken' = $4`,
          [
            this.consumerName,
            row.event_id,
            JSON.stringify({
              attempts: nextAttempt,
              lastError: `Corrupted payload/metadata: ${String(parseErr)}`,
              quarantinedAt: new Date().toISOString(),
            }),
            claimToken,
          ],
        );
        continue;
      }

      const event: DomainEvent<TPayload> = {
        eventId: row.event_id,
        eventType: row.event_type,
        eventVersion: Number(row.event_version),
        aggregateType: row.aggregate_type as string,
        aggregateId: row.aggregate_id as string,
        tenantId: row.tenant_id as string,
        occurredAt: new Date(row.occurred_at as string | Date).toISOString(),
        payload: payload as TPayload,
        metadata: (metadata ?? {}) as DomainEvent['metadata'],
      };

      // 6. Execute domain handler
      try {
        await this.handleEvent(event);

        const compRes = await this.db.query(
          `UPDATE event_consumer_receipts
           SET status = 'COMPLETED', processed_at = NOW(), error_metadata = NULL
           WHERE consumer_name = $1 AND event_id = $2
             AND status = 'PROCESSING'
             AND error_metadata->>'claimToken' = $3`,
          [this.consumerName, row.event_id, claimToken],
        );

        if ((compRes.rowCount ?? 0) > 0) {
          succeeded++;
          this.logger.info('Consumer event retry succeeded', {
            consumerName: this.consumerName,
            eventId: row.event_id,
            eventType: row.event_type,
            attempts: nextAttempt,
          });
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const isTerminal = nextAttempt >= maxAttempts;
        const finalStatus = isTerminal ? 'QUARANTINED' : 'FAILED';

        const backoffMultiplier = Math.pow(2, Math.min(Math.max(0, nextAttempt - 1), 8));
        const retryDelayMs = Math.min(baseRetryDelayMs * backoffMultiplier, maxRetryDelayMs);
        const nextRetryAt = isTerminal ? null : new Date(Date.now() + retryDelayMs).toISOString();

        const failRes = await this.db.query(
          `UPDATE event_consumer_receipts
           SET status = $1, processed_at = NOW(), error_metadata = $2
           WHERE consumer_name = $3 AND event_id = $4
             AND status = 'PROCESSING'
             AND error_metadata->>'claimToken' = $5`,
          [
            finalStatus,
            JSON.stringify({
              ...errMeta,
              attempts: nextAttempt,
              lastError: errorMessage,
              failedAt: new Date().toISOString(),
              ...(nextRetryAt ? { nextRetryAt } : {}),
              ...(isTerminal
                ? {
                    quarantinedAt: new Date().toISOString(),
                    reason: `Exceeded maximum retry attempts (${maxAttempts})`,
                  }
                : {}),
            }),
            this.consumerName,
            row.event_id,
            claimToken,
          ],
        );

        if ((failRes.rowCount ?? 0) > 0) {
          if (isTerminal) {
            quarantined++;
            this.logger.error('Consumer event retry failed and was quarantined', {
              consumerName: this.consumerName,
              eventId: row.event_id,
              eventType: row.event_type,
              attempts: nextAttempt,
              error: errorMessage,
            });
          } else {
            failed++;
            this.logger.warn('Consumer event retry failed, scheduled for next backoff', {
              consumerName: this.consumerName,
              eventId: row.event_id,
              eventType: row.event_type,
              attempts: nextAttempt,
              error: errorMessage,
            });
          }
        }
      }
    }

    return { claimed, retried, succeeded, failed, quarantined };
  }
}
