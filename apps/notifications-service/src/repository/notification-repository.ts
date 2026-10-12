import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../infra/database/connection.js';
import type {
  NotificationRecord,
  CustomerNotificationPreference,
  NotificationStatus,
  NotificationChannel,
  ConsumerReceiptRecord,
} from '../domain/models.js';

interface RawNotificationRow {
  id: string;
  tenant_id: string;
  event_id: string;
  notification_type: string;
  channel: string;
  recipient: string;
  idempotency_key: string;
  template_id: string;
  payload: Record<string, unknown> | string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  available_at: string | Date;
  sent_at: string | Date | null;
  last_error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function mapRowToNotificationRecord(row: RawNotificationRow): NotificationRecord {
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    eventId: row.event_id,
    notificationType: row.notification_type,
    channel: row.channel as NotificationChannel,
    recipient: row.recipient,
    idempotencyKey: row.idempotency_key,
    templateId: row.template_id,
    payload,
    status: row.status as NotificationStatus,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    availableAt: new Date(row.available_at).toISOString(),
    sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
    lastError: row.last_error,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export const DEFAULT_CONSUMER_RECEIPT_STALE_TIMEOUT_MS = 5 * 60 * 1000; // 300,000 ms (5 minutes)

export class NotificationRepository {
  constructor(private readonly db: DatabaseConnection) {}

  // --- Customer Preferences (customer_notification_preferences) ---

  async findCustomerPreferences(
    tenantId: string,
    customerId: string,
  ): Promise<CustomerNotificationPreference | null> {
    const res = await this.db.query<{
      id: string;
      tenant_id: string;
      customer_id: string;
      email_enabled: boolean;
      sms_enabled: boolean;
      push_enabled: boolean;
      disabled_types: string;
      created_at: string | Date;
      updated_at: string | Date;
    }>(
      `SELECT * FROM customer_notification_preferences WHERE tenant_id = $1 AND customer_id = $2`,
      [tenantId, customerId],
    );

    const row = res.rows[0];
    if (!row) return null;

    const disabledTypes = row.disabled_types ? row.disabled_types.split(',').filter(Boolean) : [];

    return {
      id: row.id,
      tenantId: row.tenant_id,
      customerId: row.customer_id,
      emailEnabled: row.email_enabled,
      smsEnabled: row.sms_enabled,
      pushEnabled: row.push_enabled,
      disabledTypes,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async upsertCustomerPreferences(pref: {
    id: string;
    tenantId: string;
    customerId: string;
    emailEnabled: boolean;
    smsEnabled: boolean;
    pushEnabled: boolean;
    disabledTypes: string[];
  }): Promise<void> {
    const disabledStr = pref.disabledTypes.join(',');
    const existing = await this.findCustomerPreferences(pref.tenantId, pref.customerId);

    if (existing) {
      await this.db.query(
        `UPDATE customer_notification_preferences
         SET email_enabled = $1,
             sms_enabled = $2,
             push_enabled = $3,
             disabled_types = $4,
             updated_at = NOW()
         WHERE tenant_id = $5 AND customer_id = $6`,
        [
          pref.emailEnabled,
          pref.smsEnabled,
          pref.pushEnabled,
          disabledStr,
          pref.tenantId,
          pref.customerId,
        ],
      );
    } else {
      await this.db.query(
        `INSERT INTO customer_notification_preferences (
          id, tenant_id, customer_id, email_enabled, sms_enabled, push_enabled, disabled_types, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
        [
          pref.id,
          pref.tenantId,
          pref.customerId,
          pref.emailEnabled,
          pref.smsEnabled,
          pref.pushEnabled,
          disabledStr,
        ],
      );
    }
  }

  // --- Notifications (notifications) ---

  async findNotificationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<NotificationRecord | null> {
    const res = await this.db.query<RawNotificationRow>(
      `SELECT * FROM notifications WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = res.rows[0];
    return row ? mapRowToNotificationRecord(row) : null;
  }

  async insertNotification(n: NotificationRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO notifications (
        id, tenant_id, event_id, notification_type, channel, recipient,
        idempotency_key, template_id, payload, status, attempt_count,
        max_attempts, available_at, sent_at, last_error, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())`,
      [
        n.id,
        n.tenantId,
        n.eventId,
        n.notificationType,
        n.channel,
        n.recipient,
        n.idempotencyKey,
        n.templateId,
        JSON.stringify(n.payload),
        n.status,
        n.attemptCount,
        n.maxAttempts,
        n.availableAt,
        n.sentAt,
        n.lastError,
      ],
    );
  }

  async claimPendingNotifications(batchSize: number): Promise<NotificationRecord[]> {
    return this.db.withTransaction(async (tx) => {
      const selectRes = await tx.query<RawNotificationRow>(
        `SELECT * FROM notifications
         WHERE (status = 'PENDING' OR status = 'RETRY_SCHEDULED') AND available_at <= NOW()
         ORDER BY available_at ASC
         LIMIT $1`,
        [batchSize],
      );

      if (selectRes.rows.length === 0) return [];

      const ids = selectRes.rows.map((r) => r.id);
      const actuallyClaimedIds: string[] = [];
      for (const id of ids) {
        const updateRes = await tx.query(
          `UPDATE notifications
           SET status = 'PROCESSING',
               attempt_count = attempt_count + 1,
               updated_at = NOW()
           WHERE id = $1
             AND (status = 'PENDING' OR status = 'RETRY_SCHEDULED')`,
          [id],
        );
        if ((updateRes.rowCount ?? 0) > 0) {
          actuallyClaimedIds.push(id);
        }
      }

      if (actuallyClaimedIds.length === 0) return [];

      const placeholders = actuallyClaimedIds.map((_, i) => `$${i + 1}`).join(', ');
      const rows = await tx.query<RawNotificationRow>(
        `SELECT * FROM notifications WHERE id IN (${placeholders}) ORDER BY available_at ASC`,
        actuallyClaimedIds,
      );
      return rows.rows.map(mapRowToNotificationRecord);
    });
  }

  async markSent(id: string): Promise<void> {
    await this.db.query(
      `UPDATE notifications
       SET status = 'SENT',
           sent_at = NOW(),
           last_error = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [id],
    );
  }

  async recordFailure(
    id: string,
    error: string,
    nextAvailableAt: Date | null,
    deadLetter: boolean,
  ): Promise<void> {
    if (deadLetter) {
      await this.db.query(
        `UPDATE notifications
         SET status = 'DEAD_LETTERED',
             last_error = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [error, id],
      );
    } else {
      await this.db.query(
        `UPDATE notifications
         SET status = 'RETRY_SCHEDULED',
             available_at = $1,
             last_error = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [nextAvailableAt ? nextAvailableAt.toISOString() : new Date().toISOString(), error, id],
      );
    }
  }

  async getNotificationById(id: string): Promise<NotificationRecord | null> {
    const res = await this.db.query<RawNotificationRow>(
      `SELECT * FROM notifications WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row ? mapRowToNotificationRecord(row) : null;
  }

  async listNotifications(
    filter: {
      tenantId?: string | undefined;
      status?: string | undefined;
      channel?: string | undefined;
      limit?: number | undefined;
      offset?: number | undefined;
    } = {},
  ): Promise<{ items: NotificationRecord[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filter.tenantId) {
      conditions.push(`tenant_id = $${idx++}`);
      params.push(filter.tenantId);
    }
    if (filter.status) {
      conditions.push(`status = $${idx++}`);
      params.push(filter.status);
    }
    if (filter.channel) {
      conditions.push(`channel = $${idx++}`);
      params.push(filter.channel);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRes = await this.db.query<{ count: string | number }>(
      `SELECT count(*) as count FROM notifications ${whereClause}`,
      params,
    );
    const total = Number(countRes.rows[0]?.count ?? 0);

    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    params.push(limit);
    const limitIdx = idx++;
    params.push(offset);
    const offsetIdx = idx++;

    const rowsRes = await this.db.query<RawNotificationRow>(
      `SELECT * FROM notifications ${whereClause} ORDER BY created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );

    return {
      items: rowsRes.rows.map(mapRowToNotificationRecord),
      total,
    };
  }

  async retryNotification(id: string): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE notifications
       SET status = 'PENDING',
           available_at = NOW(),
           attempt_count = 0,
           last_error = NULL,
           updated_at = NOW()
       WHERE id = $1 AND status IN ('FAILED', 'DEAD_LETTERED')`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  // --- Consumer Deduplication Receipts (notification_consumer_receipts) ---

  async findReceipt(consumerName: string, eventId: string): Promise<ConsumerReceiptRecord | null> {
    const res = await this.db.query<{
      id: string;
      consumer_name: string;
      event_id: string;
      claim_token?: string | null;
      processed_at: string | Date;
      status: string;
      error_metadata: string | Record<string, unknown> | null;
    }>(`SELECT * FROM notification_consumer_receipts WHERE consumer_name = $1 AND event_id = $2`, [
      consumerName,
      eventId,
    ]);

    const row = res.rows[0];
    if (!row) return null;

    const errorMetadata =
      typeof row.error_metadata === 'string' ? JSON.parse(row.error_metadata) : row.error_metadata;

    return {
      id: row.id,
      consumerName: row.consumer_name,
      eventId: row.event_id,
      claimToken: row.claim_token ?? null,
      processedAt: new Date(row.processed_at).toISOString(),
      status: row.status as 'PROCESSING' | 'COMPLETED' | 'SKIPPED' | 'FAILED' | 'QUARANTINED',
      errorMetadata,
    };
  }

  async recordReceipt(receipt: {
    id: string;
    consumerName: string;
    eventId: string;
    status: 'PROCESSING' | 'COMPLETED' | 'SKIPPED' | 'FAILED' | 'QUARANTINED';
    claimToken?: string | null;
    errorMetadata?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO notification_consumer_receipts (id, consumer_name, event_id, status, claim_token, error_metadata, processed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
      [
        receipt.id,
        receipt.consumerName,
        receipt.eventId,
        receipt.status,
        receipt.claimToken ?? null,
        receipt.errorMetadata ? JSON.stringify(receipt.errorMetadata) : null,
      ],
    );
  }

  /**
   * Updates consumer receipt status with claim-token fencing.
   *
   * Fencing Guarantees:
   * Requires a valid, non-empty claim token verifying that the caller still owns the active claim
   * (claim_token = $5 AND status = 'PROCESSING'). If claimToken is omitted, empty, or superseded
   * by another worker reclaiming or completing the receipt, the update matches zero rows and returns false.
   * This strictly prevents a stale/delayed worker from overwriting a newer worker's completion or reclaim.
   */
  async updateReceiptStatus(
    consumerName: string,
    eventId: string,
    status: 'PROCESSING' | 'COMPLETED' | 'SKIPPED' | 'FAILED' | 'QUARANTINED',
    errorMetadata?: Record<string, unknown> | null,
    claimToken?: string,
  ): Promise<boolean> {
    if (!claimToken || typeof claimToken !== 'string' || claimToken.trim() === '') {
      return false;
    }

    const res = await this.db.query(
      `UPDATE notification_consumer_receipts
       SET status = $3,
           error_metadata = $4,
           processed_at = NOW()
       WHERE consumer_name = $1
         AND event_id = $2
         AND status = 'PROCESSING'
         AND claim_token = $5`,
      [
        consumerName,
        eventId,
        status,
        errorMetadata ? JSON.stringify(errorMetadata) : null,
        claimToken,
      ],
    );

    return (res.rowCount ?? 0) > 0;
  }

  async isEventProcessed(consumerName: string, eventId: string): Promise<boolean> {
    const receipt = await this.findReceipt(consumerName, eventId);
    return receipt !== null && (receipt.status === 'COMPLETED' || receipt.status === 'PROCESSING');
  }

  /**
   * Atomically claims an event receipt for durable consumer processing.
   *
   * Lifecycle & Concurrency Guarantees:
   * 1. If no receipt exists, attempts atomic INSERT with status = 'PROCESSING' and a new claim_token.
   *    If a concurrent worker inserts simultaneously, the UNIQUE (consumer_name, event_id)
   *    constraint causes the loser to safely yield ('CURRENTLY_PROCESSING').
   * 2. If receipt status is 'COMPLETED', 'SKIPPED', or 'QUARANTINED', yields 'ALREADY_COMPLETED'.
   * 3. If receipt status is 'FAILED', atomically transitions 'FAILED' -> 'PROCESSING'
   *    and generates a new claim_token to permit safe retry under redelivery.
   * 4. If receipt status is 'PROCESSING':
   *    - If within staleTimeoutMs, yields 'CURRENTLY_PROCESSING' to prevent double-processing.
   *    - If elapsed time exceeds staleTimeoutMs (worker crashed mid-flight), atomically reclaims
   *      the stale claim using Compare-And-Swap (CAS) on the prior claim_token / processed_at.
   *      Only the single winning reclaiming worker acquires the new claim_token; competing
   *      workers match zero rows and safely yield.
   */
  async claimEventReceipt(
    consumerName: string,
    eventId: string,
    options?: { staleTimeoutMs?: number },
  ): Promise<EventClaimResult> {
    const staleTimeoutMs = options?.staleTimeoutMs ?? DEFAULT_CONSUMER_RECEIPT_STALE_TIMEOUT_MS;
    const existing = await this.findReceipt(consumerName, eventId);

    if (!existing) {
      const claimToken = randomUUID();
      try {
        await this.recordReceipt({
          id: randomUUID(),
          consumerName,
          eventId,
          status: 'PROCESSING',
          claimToken,
        });
        return { claimed: true, claimToken };
      } catch {
        // UNIQUE constraint violation: concurrent insert by sibling worker
        return { claimed: false, reason: 'CURRENTLY_PROCESSING' };
      }
    }

    if (
      existing.status === 'COMPLETED' ||
      existing.status === 'SKIPPED' ||
      existing.status === 'QUARANTINED'
    ) {
      return { claimed: false, reason: 'ALREADY_COMPLETED' };
    }

    if (existing.status === 'FAILED') {
      const claimToken = randomUUID();
      const res = await this.db.query(
        `UPDATE notification_consumer_receipts
         SET status = 'PROCESSING',
             claim_token = $3,
             processed_at = NOW(),
             error_metadata = NULL
         WHERE consumer_name = $1 AND event_id = $2 AND status = 'FAILED'`,
        [consumerName, eventId, claimToken],
      );
      if ((res.rowCount ?? 0) > 0) {
        return { claimed: true, claimToken };
      }
      return { claimed: false, reason: 'CURRENTLY_PROCESSING' };
    }

    if (existing.status === 'PROCESSING') {
      const elapsedMs = Date.now() - new Date(existing.processedAt).getTime();
      if (elapsedMs >= staleTimeoutMs) {
        const newClaimToken = randomUUID();
        const staleThreshold = new Date(Date.now() - staleTimeoutMs).toISOString();
        // Atomic CAS: compare-and-swap on prior claim_token or processed_at with stale threshold
        const res = await this.db.query(
          `UPDATE notification_consumer_receipts
           SET status = 'PROCESSING',
               claim_token = $3,
               processed_at = NOW()
           WHERE consumer_name = $1 AND event_id = $2
             AND status = 'PROCESSING'
             AND (
               (claim_token IS NOT NULL AND claim_token = $4)
               OR (claim_token IS NULL AND processed_at = $5)
             )
             AND processed_at <= $6`,
          [
            consumerName,
            eventId,
            newClaimToken,
            existing.claimToken ?? '',
            existing.processedAt,
            staleThreshold,
          ],
        );
        if ((res.rowCount ?? 0) > 0) {
          return { claimed: true, claimToken: newClaimToken };
        }
      }
      return { claimed: false, reason: 'CURRENTLY_PROCESSING' };
    }

    return { claimed: false, reason: 'CURRENTLY_PROCESSING' };
  }

  async recordEventReceipt(input: {
    consumerName: string;
    eventId: string;
    eventType?: string;
  }): Promise<void> {
    await this.recordReceipt({
      id: randomUUID(),
      consumerName: input.consumerName,
      eventId: input.eventId,
      status: 'COMPLETED',
      errorMetadata: input.eventType ? { eventType: input.eventType } : null,
    });
  }
}

export type EventClaimResult =
  | { claimed: true; claimToken: string }
  | { claimed: false; reason: 'ALREADY_COMPLETED' | 'CURRENTLY_PROCESSING' };
