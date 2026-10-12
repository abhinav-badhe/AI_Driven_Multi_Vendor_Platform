import { randomUUID } from 'node:crypto';
import { AppError, ValidationError } from '../../../errors/app-error.js';
import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import { EventTypes, type DomainEvent, type EventTransport } from '../../events/index.js';

export const CONSUMER_NAME = 'notifications-http-forwarder';
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024; // 64 KB limit

/**
 * Event types that trigger notification dispatch and must be forwarded
 * to the standalone Notifications microservice when HTTP mode is active.
 */
export const NOTIFICATION_EVENT_TYPES = [
  EventTypes.ORDER_CREATED,
  EventTypes.PAYMENT_SUCCEEDED,
  EventTypes.PAYMENT_FAILED,
  EventTypes.FULFILLMENT_SHIPMENT_STATUS_CHANGED,
  EventTypes.FULFILLMENT_RETURN_STATUS_CHANGED,
  EventTypes.SETTLEMENT_STATUS_CHANGED,
] as const;

export type NotificationRelevantEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export class HttpEventForwarderError extends AppError {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(
    message: string,
    statusCode = 502,
    code = 'EVENT_FORWARDING_ERROR',
    details?: unknown,
  ) {
    super(message, details);
    this.name = 'HttpEventForwarderError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface HttpEventForwarderConfig {
  baseUrl: string;
  internalServiceKey: string;
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  db?: DatabaseConnection | undefined;
  maxResponseBytes?: number | undefined;
  staleTimeoutMs?: number | undefined;
  baseRetryDelayMs?: number | undefined;
  maxRetryDelayMs?: number | undefined;
  maxAttempts?: number | undefined;
}

/**
 * Reads a response stream up to maxBytes, enforcing strict bounds on downstream memory consumption.
 * Cancels the underlying stream if maxBytes is exceeded.
 */
export async function readBoundedText(
  response: Response,
  maxBytes: number = DEFAULT_MAX_RESPONSE_BYTES,
  errorFactory?: (maxBytes: number, details?: string) => Error,
): Promise<string> {
  const createError = (bytes: number, details?: string): Error => {
    if (errorFactory) {
      return errorFactory(bytes, details);
    }
    return new HttpEventForwarderError(
      `Response payload exceeded maximum allowed size of ${bytes} bytes${details ? ` (${details})` : ''}`,
      502,
      'EVENT_FORWARDING_RESPONSE_TOO_LARGE',
    );
  };

  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      // Ignore body cancellation error
    }
    throw createError(maxBytes, `Content-Length: ${contentLength}`);
  }

  if (!response.body) {
    try {
      const text = await response.text();
      if (text.length > maxBytes) {
        throw createError(maxBytes);
      }
      return text;
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err instanceof HttpEventForwarderError ||
          (errorFactory && err.message.includes('exceeded maximum allowed size')))
      ) {
        throw err;
      }
      return '';
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // Ignore cancel error
          }
          throw createError(maxBytes);
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore reader lock release errors on cancelled or closed streams
    }
  }

  return Buffer.concat(chunks).toString('utf8');
}

export class HttpEventForwarder {
  private readonly baseUrl: string;
  private readonly internalServiceKey: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly db?: DatabaseConnection | undefined;
  private readonly maxResponseBytes: number;
  private readonly staleTimeoutMs: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly defaultMaxAttempts: number;

  constructor(
    config: HttpEventForwarderConfig,
    private readonly logger?: Logger,
  ) {
    if (!config || typeof config !== 'object') {
      throw new ValidationError('HttpEventForwarderConfig is required and must be an object');
    }

    this.baseUrl = (config.baseUrl || '').trim().replace(/\/+$/, '');
    if (!this.baseUrl) {
      throw new ValidationError('Notifications service baseUrl is required for HttpEventForwarder');
    }

    try {
      new URL(this.baseUrl);
    } catch {
      throw new ValidationError(`Invalid Notifications service baseUrl: '${this.baseUrl}'`);
    }

    this.internalServiceKey = (config.internalServiceKey || '').trim();
    if (!this.internalServiceKey || this.internalServiceKey.length < 16) {
      throw new ValidationError(
        'Notifications service internalServiceKey must be at least 16 characters',
      );
    }

    this.timeoutMs = config.timeoutMs ?? 5000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new ValidationError('Notifications service timeoutMs must be a positive integer');
    }

    this.fetchFn = config.fetchFn ?? globalThis.fetch;
    this.db = config.db;
    this.maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

    this.staleTimeoutMs = config.staleTimeoutMs ?? 5 * 60 * 1000;
    if (!Number.isInteger(this.staleTimeoutMs) || this.staleTimeoutMs <= 0) {
      throw new ValidationError('Notifications service staleTimeoutMs must be a positive integer');
    }

    this.baseRetryDelayMs = config.baseRetryDelayMs ?? 2000;
    if (!Number.isInteger(this.baseRetryDelayMs) || this.baseRetryDelayMs < 0) {
      throw new ValidationError(
        'Notifications service baseRetryDelayMs must be a non-negative integer',
      );
    }

    this.maxRetryDelayMs = config.maxRetryDelayMs ?? 5 * 60 * 1000;
    if (!Number.isInteger(this.maxRetryDelayMs) || this.maxRetryDelayMs <= 0) {
      throw new ValidationError('Notifications service maxRetryDelayMs must be a positive integer');
    }

    this.defaultMaxAttempts = config.maxAttempts ?? 5;
    if (!Number.isInteger(this.defaultMaxAttempts) || this.defaultMaxAttempts <= 0) {
      throw new ValidationError('Notifications service maxAttempts must be a positive integer');
    }
  }

  /**
   * Subscribes this forwarder to all notification-relevant event types on the configured transport.
   * If db is provided, forwards through processEvent ensuring failure isolation and durable receipt tracking.
   */
  registerSubscriptions(transport: EventTransport): void {
    for (const evt of NOTIFICATION_EVENT_TYPES) {
      transport.subscribe(evt, async (event) => {
        if (this.db) {
          await this.processEvent(event);
        } else {
          await this.forward(event);
        }
      });
    }
  }

  /**
   * Safe consumer processing pipeline when database connection is provided:
   * 1. Claims receipt atomically as PROCESSING with unique claim token.
   *    If receipt already exists (FAILED or stale PROCESSING), reclaims via atomic CAS.
   * 2. Forwards to standalone Notifications service.
   * 3. On success: marks receipt COMPLETED only if claim token matches (fencing).
   * 4. On failure: marks receipt FAILED (or QUARANTINED if max attempts reached)
   *    with incremented attempts and error metadata only if claim token matches.
   *    Never rethrows, ensuring sibling consumers on transport and outbox are isolated.
   */
  async processEvent(
    event: DomainEvent<unknown>,
  ): Promise<{ handled: boolean; duplicate: boolean; error?: string }> {
    if (!this.db) {
      await this.forward(event);
      return { handled: true, duplicate: false };
    }

    const eventId = event.eventId;
    const claimToken = randomUUID();

    // 1. Attempt atomic initial receipt insertion with status = 'PROCESSING'
    let claimed = false;
    let priorAttempts = 0;

    try {
      await this.db.query(
        `INSERT INTO event_consumer_receipts (id, consumer_name, event_id, status, error_metadata, processed_at, created_at)
         VALUES ($1, $2, $3, 'PROCESSING', $4, NOW(), NOW())`,
        [
          randomUUID(),
          CONSUMER_NAME,
          eventId,
          JSON.stringify({
            claimToken,
            attempts: 1,
            claimedAt: new Date().toISOString(),
          }),
        ],
      );
      claimed = true;
      priorAttempts = 0;
    } catch {
      // UNIQUE constraint violation: receipt already exists
    }

    // 2. If initial insertion conflicted, inspect and attempt atomic reclaim
    if (!claimed) {
      const existingRes = await this.db.query<{
        status: string;
        error_metadata: Record<string, unknown> | string | null;
        processed_at: string | Date;
      }>(
        `SELECT status, error_metadata, processed_at
         FROM event_consumer_receipts
         WHERE consumer_name = $1 AND event_id = $2`,
        [CONSUMER_NAME, eventId],
      );

      const existing = existingRes.rows[0];
      if (!existing) {
        return { handled: false, duplicate: true };
      }

      if (
        existing.status === 'COMPLETED' ||
        existing.status === 'SKIPPED' ||
        existing.status === 'QUARANTINED'
      ) {
        this.logger?.info('Duplicate event delivery to forwarder detected and safely skipped', {
          consumerName: CONSUMER_NAME,
          eventId,
          priorStatus: existing.status,
        });
        return { handled: false, duplicate: true };
      }

      let errMeta: Record<string, unknown> | null = null;
      try {
        errMeta =
          typeof existing.error_metadata === 'string'
            ? JSON.parse(existing.error_metadata)
            : existing.error_metadata;
      } catch {
        errMeta = null;
      }

      const existingAttempts =
        errMeta &&
        typeof errMeta.attempts === 'number' &&
        Number.isInteger(errMeta.attempts) &&
        errMeta.attempts > 0
          ? errMeta.attempts
          : 1;

      if (existing.status === 'PROCESSING') {
        const processedTime = new Date(existing.processed_at).getTime();
        const isStale = Date.now() - processedTime > this.staleTimeoutMs;
        if (!isStale) {
          this.logger?.info('Duplicate event delivery skipped: active worker already processing', {
            consumerName: CONSUMER_NAME,
            eventId,
          });
          return { handled: false, duplicate: true };
        }
      }

      // If attempts already reached limit, permanently quarantine
      if (existingAttempts >= this.defaultMaxAttempts) {
        await this.db.query(
          `UPDATE event_consumer_receipts
           SET status = 'QUARANTINED', processed_at = NOW()
           WHERE consumer_name = $1 AND event_id = $2 AND status != 'QUARANTINED'`,
          [CONSUMER_NAME, eventId],
        );
        this.logger?.error(
          'Notification event forwarding exceeded max attempts and was quarantined',
          {
            consumerName: CONSUMER_NAME,
            eventId,
            attempts: existingAttempts,
          },
        );
        return { handled: false, duplicate: true };
      }

      // Atomic CAS reclaim of FAILED or stale PROCESSING receipt
      const staleThreshold = new Date(Date.now() - this.staleTimeoutMs).toISOString();
      const updateRes = await this.db.query(
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
          CONSUMER_NAME,
          eventId,
          JSON.stringify({
            claimToken,
            attempts: existingAttempts + 1,
            claimedAt: new Date().toISOString(),
          }),
          staleThreshold,
        ],
      );

      if ((updateRes.rowCount ?? 0) === 1) {
        claimed = true;
        priorAttempts = existingAttempts;
      } else {
        // Lost claim race to concurrent worker
        return { handled: false, duplicate: true };
      }
    }

    const currentAttempt = priorAttempts + 1;

    // 3. Forward to standalone endpoint
    try {
      await this.forward(event);

      // Fenced completion update: only succeed if we still own this claim
      const compRes = await this.db.query(
        `UPDATE event_consumer_receipts
         SET status = 'COMPLETED', processed_at = NOW(), error_metadata = NULL
         WHERE consumer_name = $1 AND event_id = $2
           AND status = 'PROCESSING'
           AND error_metadata->>'claimToken' = $3`,
        [CONSUMER_NAME, eventId, claimToken],
      );

      if ((compRes.rowCount ?? 0) === 0) {
        this.logger?.warn(
          'Forwarder completed remote request but local claim expired or was superseded; avoided overwriting state',
          { consumerName: CONSUMER_NAME, eventId, claimToken },
        );
        return { handled: false, duplicate: true };
      }

      return { handled: true, duplicate: false };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Fenced failure update: only update if we still own this claim
      await this.db.query(
        `UPDATE event_consumer_receipts
         SET status = 'FAILED', processed_at = NOW(), error_metadata = $1
         WHERE consumer_name = $2 AND event_id = $3
           AND status = 'PROCESSING'
           AND error_metadata->>'claimToken' = $4`,
        [
          JSON.stringify({
            attempts: currentAttempt,
            lastError: errorMsg,
            failedAt: new Date().toISOString(),
          }),
          CONSUMER_NAME,
          eventId,
          claimToken,
        ],
      );

      this.logger?.warn(
        'Event forwarding to Notifications service failed; isolated to forwarder receipt retry',
        {
          consumerName: CONSUMER_NAME,
          eventId,
          attempts: currentAttempt,
          error: errorMsg,
        },
      );
      return { handled: false, duplicate: false, error: errorMsg };
    }
  }

  /**
   * Independent retry worker: scans event_consumer_receipts for FAILED or stale PROCESSING receipts,
   * enforces bounded exponential backoff, atomically claims eligible receipts using claimToken CAS,
   * and retries delivery. Exhausted receipts (attempts >= maxAttempts) are permanently quarantined.
   */
  async retryFailedEvents(options?: {
    maxAttempts?: number;
    batchSize?: number;
    baseRetryDelayMs?: number;
    maxRetryDelayMs?: number;
    staleTimeoutMs?: number;
  }): Promise<{
    claimed: number;
    retried: number;
    succeeded: number;
    failed: number;
    quarantined: number;
  }> {
    if (!this.db) {
      return { claimed: 0, retried: 0, succeeded: 0, failed: 0, quarantined: 0 };
    }

    const maxAttempts = options?.maxAttempts ?? this.defaultMaxAttempts;
    const batchSize = options?.batchSize ?? 50;
    const baseRetryDelayMs = options?.baseRetryDelayMs ?? this.baseRetryDelayMs;
    const maxRetryDelayMs = options?.maxRetryDelayMs ?? this.maxRetryDelayMs;
    const staleTimeoutMs = options?.staleTimeoutMs ?? this.staleTimeoutMs;

    // Filter candidates in SQL:
    // 1. FAILED receipts where processed_at is older than baseRetryDelayMs
    // 2. Stale PROCESSING receipts where processed_at is older than staleTimeoutMs
    const baseDelayThreshold = new Date(Date.now() - baseRetryDelayMs).toISOString();
    const staleThreshold = new Date(Date.now() - staleTimeoutMs).toISOString();

    const res = await this.db.query<{
      event_id: string;
      event_type: string;
      event_version: number;
      aggregate_type: string;
      aggregate_id: string;
      tenant_id: string;
      occurred_at: string | Date;
      payload: Record<string, unknown> | string;
      metadata: Record<string, unknown> | string;
      error_metadata: Record<string, unknown> | string | null;
      processed_at: string | Date;
      status: string;
    }>(
      `SELECT o.event_id, o.event_type, o.event_version, o.aggregate_type, o.aggregate_id,
              o.tenant_id, o.occurred_at, o.payload, o.metadata,
              r.error_metadata, r.processed_at, r.status
       FROM outbox_events o
       INNER JOIN event_consumer_receipts r
         ON r.consumer_name = $1 AND r.event_id = o.event_id
       WHERE (r.status = 'FAILED' AND r.processed_at <= $2)
          OR (r.status = 'PROCESSING' AND r.processed_at <= $3)
       ORDER BY r.processed_at ASC
       LIMIT $4`,
      [CONSUMER_NAME, baseDelayThreshold, staleThreshold, batchSize],
    );

    let claimed = 0;
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

      // 1. Enforce max attempts quarantine
      if (currentAttempts >= maxAttempts) {
        const qRes = await this.db.query(
          `UPDATE event_consumer_receipts
           SET status = 'QUARANTINED', processed_at = NOW()
           WHERE consumer_name = $1 AND event_id = $2
             AND (status = 'FAILED' OR status = 'PROCESSING')`,
          [CONSUMER_NAME, row.event_id],
        );
        if ((qRes.rowCount ?? 0) > 0) {
          quarantined += 1;
          this.logger?.error(
            'Notification event forwarding exceeded max attempts and was quarantined',
            {
              consumerName: CONSUMER_NAME,
              eventId: row.event_id,
              attempts: currentAttempts,
            },
          );
        }
        continue;
      }

      // 2. Apply bounded exponential backoff for FAILED receipts
      if (row.status === 'FAILED') {
        const backoffMultiplier = Math.pow(2, Math.min(Math.max(0, currentAttempts - 1), 8));
        const retryDelayMs = Math.min(baseRetryDelayMs * backoffMultiplier, maxRetryDelayMs);
        const failedAtTime = errMeta?.failedAt
          ? new Date(String(errMeta.failedAt)).getTime()
          : new Date(row.processed_at).getTime();
        const baseTime = Number.isNaN(failedAtTime)
          ? new Date(row.processed_at).getTime()
          : failedAtTime;
        const eligibleAt = baseTime + retryDelayMs;

        if (Date.now() < eligibleAt) {
          // Not yet eligible according to exponential backoff
          continue;
        }
      }

      // 3. Atomic CAS claim with claimToken
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
          CONSUMER_NAME,
          row.event_id,
          JSON.stringify({
            claimToken,
            attempts: nextAttempt,
            claimedAt: new Date().toISOString(),
            lastError: errMeta?.lastError,
          }),
          new Date(Date.now() - staleTimeoutMs).toISOString(),
        ],
      );

      if ((claimRes.rowCount ?? 0) === 0) {
        // Lost claim race to another worker
        continue;
      }

      claimed += 1;

      // 4. Parse payload and metadata safely
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
        quarantined += 1;
        await this.db.query(
          `UPDATE event_consumer_receipts
           SET status = 'QUARANTINED', processed_at = NOW(), error_metadata = $3
           WHERE consumer_name = $1 AND event_id = $2
             AND status = 'PROCESSING' AND error_metadata->>'claimToken' = $4`,
          [
            CONSUMER_NAME,
            row.event_id,
            JSON.stringify({
              attempts: nextAttempt,
              lastError: `Corrupted payload/metadata: ${String(parseErr)}`,
            }),
            claimToken,
          ],
        );
        continue;
      }

      const event: DomainEvent = {
        eventId: row.event_id,
        eventType: row.event_type,
        eventVersion: row.event_version,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        tenantId: row.tenant_id,
        occurredAt: new Date(row.occurred_at).toISOString(),
        payload,
        metadata,
      };

      // 5. Forward and handle fenced update
      try {
        await this.forward(event);

        const compRes = await this.db.query(
          `UPDATE event_consumer_receipts
           SET status = 'COMPLETED', processed_at = NOW(), error_metadata = NULL
           WHERE consumer_name = $1 AND event_id = $2
             AND status = 'PROCESSING'
             AND error_metadata->>'claimToken' = $3`,
          [CONSUMER_NAME, row.event_id, claimToken],
        );

        if ((compRes.rowCount ?? 0) > 0) {
          succeeded += 1;
        } else {
          this.logger?.warn(
            'Retry forwarder completed remote request but local claim expired or was superseded; avoided overwriting state',
            { consumerName: CONSUMER_NAME, eventId: row.event_id, claimToken },
          );
        }
      } catch (err: unknown) {
        failed += 1;
        const errorMsg = err instanceof Error ? err.message : String(err);

        await this.db.query(
          `UPDATE event_consumer_receipts
           SET status = 'FAILED', processed_at = NOW(), error_metadata = $1
           WHERE consumer_name = $2 AND event_id = $3
             AND status = 'PROCESSING'
             AND error_metadata->>'claimToken' = $4`,
          [
            JSON.stringify({
              attempts: nextAttempt,
              lastError: errorMsg,
              failedAt: new Date().toISOString(),
            }),
            CONSUMER_NAME,
            row.event_id,
            claimToken,
          ],
        );
      }
    }

    return {
      claimed,
      retried: succeeded,
      succeeded,
      failed,
      quarantined,
    };
  }

  /**
   * Forwards a domain event to the standalone Notifications service's ingestion endpoint.
   *
   * Acknowledgement Semantics:
   * - HTTP 200 with status PROCESSED or ALREADY_COMPLETED: Delivery acknowledged (resolves).
   * - HTTP 409 (CURRENTLY_PROCESSING), HTTP 413, HTTP 5xx, 4xx, network timeouts, or malformed responses:
   *   Rejects with HttpEventForwarderError.
   */
  async forward(event: DomainEvent<unknown>): Promise<void> {
    const url = `${this.baseUrl}/v1/internal/events/ingest`;

    const envelope = {
      eventId: event.eventId,
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      tenantId: event.tenantId,
      occurredAt: event.occurredAt,
      payload: event.payload,
      metadata: event.metadata,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Event forwarding to ${url} timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Internal-Service-Key': this.internalServiceKey,
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const isAbortOrTimeout =
        controller.signal.aborted ||
        (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'));

      if (isAbortOrTimeout) {
        this.logger?.warn('Event forwarding to Notifications service timed out', {
          eventId: event.eventId,
          eventType: event.eventType,
          timeoutMs: this.timeoutMs,
        });
        throw new HttpEventForwarderError(
          `Event forwarding for '${event.eventId}' timed out after ${this.timeoutMs}ms`,
          504,
          'EVENT_FORWARDING_TIMEOUT',
        );
      }

      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger?.warn('Event forwarding to Notifications service failed with network error', {
        eventId: event.eventId,
        eventType: event.eventType,
        error: errorMessage,
      });
      throw new HttpEventForwarderError(
        `Event forwarding network request failed: ${errorMessage}`,
        502,
        'EVENT_FORWARDING_NETWORK_ERROR',
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 200) {
      let rawText = '';
      try {
        rawText = await readBoundedText(response, this.maxResponseBytes);
      } catch (err: unknown) {
        if (err instanceof HttpEventForwarderError) throw err;
        throw new HttpEventForwarderError(
          `Failed to read response body: ${err instanceof Error ? err.message : String(err)}`,
          502,
          'EVENT_FORWARDING_NETWORK_ERROR',
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch (err: unknown) {
        throw new HttpEventForwarderError(
          `Notifications service returned malformed JSON on event ingestion: ${err instanceof Error ? err.message : String(err)}`,
          502,
          'EVENT_FORWARDING_MALFORMED_RESPONSE',
        );
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new HttpEventForwarderError(
          'Notifications service returned non-object JSON response on event ingestion',
          502,
          'EVENT_FORWARDING_MALFORMED_RESPONSE',
        );
      }

      const body = parsed as Record<string, unknown>;
      const status = body.status;

      if (status === 'PROCESSED' || status === 'ALREADY_COMPLETED') {
        this.logger?.info('Domain event successfully acknowledged by Notifications service', {
          eventId: event.eventId,
          eventType: event.eventType,
          status,
          handled: body.handled,
          duplicate: body.duplicate,
        });
        return;
      }

      throw new HttpEventForwarderError(
        `Notifications service returned unexpected status '${String(status)}' on HTTP 200`,
        502,
        'EVENT_FORWARDING_UNEXPECTED_STATUS',
      );
    }

    if (response.status === 409) {
      this.logger?.warn('Event ingestion deferred: currently processing on another worker', {
        eventId: event.eventId,
        eventType: event.eventType,
        statusCode: 409,
      });
      throw new HttpEventForwarderError(
        `Event '${event.eventId}' is currently being processed by another worker (HTTP 409 Conflict)`,
        409,
        'EVENT_FORWARDING_IN_PROGRESS',
      );
    }

    if (response.status === 413) {
      this.logger?.error('Notifications service rejected event payload as oversized (HTTP 413)', {
        eventId: event.eventId,
        eventType: event.eventType,
        statusCode: 413,
      });
      throw new HttpEventForwarderError(
        `Notifications service event ingestion rejected payload as oversized (HTTP 413)`,
        413,
        'EVENT_FORWARDING_PAYLOAD_TOO_LARGE',
      );
    }

    let errorDetail = '';
    try {
      const text = await readBoundedText(response, this.maxResponseBytes);
      try {
        const json = JSON.parse(text) as Record<string, unknown>;
        if (json.error && typeof json.error === 'object') {
          const errObj = json.error as Record<string, unknown>;
          errorDetail =
            (typeof errObj.message === 'string' && errObj.message) || text.slice(0, 500);
        } else if (typeof json.message === 'string') {
          errorDetail = json.message;
        } else {
          errorDetail = text.slice(0, 500);
        }
      } catch {
        errorDetail = text.slice(0, 500);
      }
    } catch {
      // Ignore body read failure
    }

    if (response.status === 401 || response.status === 403) {
      this.logger?.error('Event forwarding authentication failed with Notifications service', {
        eventId: event.eventId,
        eventType: event.eventType,
        statusCode: response.status,
      });
      throw new HttpEventForwarderError(
        `Notifications service event ingestion authentication failed (HTTP ${response.status})`,
        response.status,
        'EVENT_FORWARDING_AUTH_ERROR',
      );
    }

    this.logger?.warn('Notifications service event ingestion returned non-success response', {
      eventId: event.eventId,
      eventType: event.eventType,
      statusCode: response.status,
      error: errorDetail || response.statusText,
    });

    throw new HttpEventForwarderError(
      `Notifications service event ingestion failed (HTTP ${response.status}): ${errorDetail || response.statusText}`,
      response.status,
      'EVENT_FORWARDING_SERVICE_ERROR',
    );
  }
}
