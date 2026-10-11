import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { DomainEvent } from './event-envelope.js';

export interface OutboxEventRecord {
  eventId: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  tenantId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  status: 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED' | 'DEAD_LETTERED';
  attemptCount: number;
  availableAt: string;
  leaseExpiresAt: string | null;
  publishedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConsumerReceiptRecord {
  id: string;
  consumerName: string;
  eventId: string;
  processedAt: string;
  status: 'PROCESSING' | 'COMPLETED' | 'SKIPPED' | 'FAILED' | 'QUARANTINED';
  errorMetadata: Record<string, unknown> | null;
  createdAt: string;
}

interface RawOutboxRow {
  event_id: string;
  event_type: string;
  event_version: number;
  aggregate_type: string;
  aggregate_id: string;
  tenant_id: string;
  occurred_at: string | Date;
  payload: Record<string, unknown> | string;
  metadata: Record<string, unknown> | string;
  status: 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED' | 'DEAD_LETTERED';
  attempt_count: number;
  available_at: string | Date;
  lease_expires_at: string | Date | null;
  published_at: string | Date | null;
  last_error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function mapRowToOutboxRecord(row: RawOutboxRow): OutboxEventRecord {
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    tenantId: row.tenant_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    payload,
    metadata,
    status: row.status,
    attemptCount: row.attempt_count,
    availableAt: new Date(row.available_at).toISOString(),
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    lastError: row.last_error,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class OutboxRepository {
  /**
   * Atomically insert an event record within the caller's active database transaction.
   */
  async insertEvent(tx: DatabaseConnection, event: DomainEvent): Promise<void> {
    await tx.query(
      `INSERT INTO outbox_events (
        event_id, event_type, event_version, aggregate_type, aggregate_id,
        tenant_id, occurred_at, payload, metadata, status, attempt_count,
        available_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING', 0, NOW(), NOW(), NOW())`,
      [
        event.eventId,
        event.eventType,
        event.eventVersion,
        event.aggregateType,
        event.aggregateId,
        event.tenantId,
        event.occurredAt,
        JSON.stringify(event.payload),
        JSON.stringify(event.metadata),
      ],
    );
  }

  /**
   * Safely claim a batch of eligible unpublished events using row-level locking or lease expiry.
   * If a previous worker crashed while status was 'PROCESSING', the lease expiration allows reclamation.
   */
  async claimBatch(
    db: DatabaseConnection,
    batchSize: number,
    leaseDurationMs: number,
  ): Promise<OutboxEventRecord[]> {
    return db.withTransaction(async (tx) => {
      // Find candidate events:
      // 1. status = 'PENDING' AND available_at <= NOW()
      // 2. OR status = 'PROCESSING' AND lease_expires_at < NOW() (crashed worker lease recovery)
      const selectRes = await tx.query<RawOutboxRow>(
        `SELECT * FROM outbox_events
         WHERE (status = 'PENDING' AND available_at <= NOW())
            OR (status = 'PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW())
         ORDER BY available_at ASC
         LIMIT $1`,
        [batchSize],
      );

      if (selectRes.rows.length === 0) {
        return [];
      }

      const eventIds = selectRes.rows.map((r) => r.event_id);
      const leaseExpiresAt = new Date(Date.now() + leaseDurationMs).toISOString();

      const actuallyClaimedIds: string[] = [];

      // Mark claimed records as PROCESSING with lease timestamp and incremented attempt_count
      // Concurrency guard: only update if status is still PENDING or lease has expired
      for (const id of eventIds) {
        const updateRes = await tx.query(
          `UPDATE outbox_events
           SET status = 'PROCESSING',
               lease_expires_at = $1,
               attempt_count = attempt_count + 1,
               updated_at = NOW()
           WHERE event_id = $2
             AND (status = 'PENDING' OR (status = 'PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW()))`,
          [leaseExpiresAt, id],
        );
        if ((updateRes.rowCount ?? 0) > 0) {
          actuallyClaimedIds.push(id);
        }
      }

      if (actuallyClaimedIds.length === 0) {
        return [];
      }

      // Re-fetch updated records
      const placeholders = actuallyClaimedIds.map((_, i) => `$${i + 1}`).join(', ');
      const updatedRes = await tx.query<RawOutboxRow>(
        `SELECT * FROM outbox_events WHERE event_id IN (${placeholders}) ORDER BY available_at ASC`,
        actuallyClaimedIds,
      );

      return updatedRes.rows.map(mapRowToOutboxRecord);
    });
  }

  /**
   * Mark event as successfully published to the event transport.
   */
  async markPublished(db: DatabaseConnection, eventId: string): Promise<void> {
    await db.query(
      `UPDATE outbox_events
       SET status = 'PUBLISHED',
           published_at = NOW(),
           lease_expires_at = NULL,
           last_error = NULL,
           updated_at = NOW()
       WHERE event_id = $1`,
      [eventId],
    );
  }

  /**
   * Record a publish failure, scheduling a backoff retry or transitioning to DEAD_LETTERED.
   */
  async recordFailure(
    db: DatabaseConnection,
    eventId: string,
    error: string,
    nextAvailableAt: Date | null,
    deadLetter: boolean,
  ): Promise<void> {
    if (deadLetter) {
      await db.query(
        `UPDATE outbox_events
         SET status = 'DEAD_LETTERED',
             lease_expires_at = NULL,
             last_error = $1,
             updated_at = NOW()
         WHERE event_id = $2`,
        [error, eventId],
      );
    } else {
      await db.query(
        `UPDATE outbox_events
         SET status = 'PENDING',
             available_at = $1,
             lease_expires_at = NULL,
             last_error = $2,
             updated_at = NOW()
         WHERE event_id = $3`,
        [nextAvailableAt ? nextAvailableAt.toISOString() : new Date().toISOString(), error, eventId],
      );
    }
  }

  /**
   * Controlled administrative replay of a dead-lettered or failed event.
   */
  async replayEvent(db: DatabaseConnection, eventId: string): Promise<boolean> {
    const res = await db.query(
      `UPDATE outbox_events
       SET status = 'PENDING',
           available_at = NOW(),
           attempt_count = 0,
           lease_expires_at = NULL,
           last_error = NULL,
           updated_at = NOW()
       WHERE event_id = $1 AND status IN ('DEAD_LETTERED', 'FAILED')`,
      [eventId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async getEventById(db: DatabaseConnection, eventId: string): Promise<OutboxEventRecord | null> {
    const res = await db.query<RawOutboxRow>(
      `SELECT * FROM outbox_events WHERE event_id = $1`,
      [eventId],
    );
    const row = res.rows[0];
    return row ? mapRowToOutboxRecord(row) : null;
  }

  async listEvents(
    db: DatabaseConnection,
    filter: {
      status?: string | undefined;
      tenantId?: string | undefined;
      eventType?: string | undefined;
      limit?: number | undefined;
      offset?: number | undefined;
    } = {},
  ): Promise<{ items: OutboxEventRecord[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filter.status) {
      conditions.push(`status = $${idx++}`);
      params.push(filter.status);
    }
    if (filter.tenantId) {
      conditions.push(`tenant_id = $${idx++}`);
      params.push(filter.tenantId);
    }
    if (filter.eventType) {
      conditions.push(`event_type = $${idx++}`);
      params.push(filter.eventType);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRes = await db.query<{ count: string | number }>(
      `SELECT count(*) as count FROM outbox_events ${whereClause}`,
      params,
    );
    const total = Number(countRes.rows[0]?.count ?? 0);

    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    params.push(limit);
    const limitIdx = idx++;
    params.push(offset);
    const offsetIdx = idx++;

    const rowsRes = await db.query<RawOutboxRow>(
      `SELECT * FROM outbox_events ${whereClause} ORDER BY created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );

    return {
      items: rowsRes.rows.map(mapRowToOutboxRecord),
      total,
    };
  }

  // --- Consumer Deduplication Receipts ---

  async findReceipt(
    db: DatabaseConnection,
    consumerName: string,
    eventId: string,
  ): Promise<ConsumerReceiptRecord | null> {
    const res = await db.query<{
      id: string;
      consumer_name: string;
      event_id: string;
      processed_at: string | Date;
      status: 'PROCESSING' | 'COMPLETED' | 'SKIPPED' | 'FAILED' | 'QUARANTINED';
      error_metadata: Record<string, unknown> | string | null;
      created_at: string | Date;
    }>(
      `SELECT * FROM event_consumer_receipts WHERE consumer_name = $1 AND event_id = $2`,
      [consumerName, eventId],
    );
    const row = res.rows[0];
    if (!row) return null;
    const errorMetadata =
      typeof row.error_metadata === 'string'
        ? JSON.parse(row.error_metadata)
        : row.error_metadata;
    return {
      id: row.id,
      consumerName: row.consumer_name,
      eventId: row.event_id,
      processedAt: new Date(row.processed_at).toISOString(),
      status: row.status,
      errorMetadata: errorMetadata ?? null,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async recordReceipt(
    tx: DatabaseConnection,
    receipt: {
      id: string;
      consumerName: string;
      eventId: string;
      status: 'PROCESSING' | 'COMPLETED' | 'SKIPPED' | 'FAILED' | 'QUARANTINED';
      errorMetadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO event_consumer_receipts (
        id, consumer_name, event_id, processed_at, status, error_metadata, created_at
      ) VALUES ($1, $2, $3, NOW(), $4, $5, NOW())`,
      [
        receipt.id,
        receipt.consumerName,
        receipt.eventId,
        receipt.status,
        receipt.errorMetadata ? JSON.stringify(receipt.errorMetadata) : null,
      ],
    );
  }

  async updateReceiptStatus(
    db: DatabaseConnection,
    consumerName: string,
    eventId: string,
    status: 'PROCESSING' | 'COMPLETED' | 'SKIPPED' | 'FAILED' | 'QUARANTINED',
    errorMetadata?: Record<string, unknown>,
  ): Promise<void> {
    await db.query(
      `UPDATE event_consumer_receipts
       SET status = $1,
           error_metadata = $2,
           processed_at = NOW()
       WHERE consumer_name = $3 AND event_id = $4`,
      [
        status,
        errorMetadata ? JSON.stringify(errorMetadata) : null,
        consumerName,
        eventId,
      ],
    );
  }

  /**
   * Resets all consumer receipts for a specific consumer, enabling clean event stream replay and projection recovery.
   */
  async clearReceiptsForConsumer(db: DatabaseConnection, consumerName: string): Promise<number> {
    const res = await db.query(`DELETE FROM event_consumer_receipts WHERE consumer_name = $1`, [consumerName]);
    return res.rowCount ?? 0;
  }

  /**
   * Clears a single consumer receipt for specific event replay.
   */
  async deleteReceipt(db: DatabaseConnection, consumerName: string, eventId: string): Promise<boolean> {
    const res = await db.query(
      `DELETE FROM event_consumer_receipts WHERE consumer_name = $1 AND event_id = $2`,
      [consumerName, eventId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

