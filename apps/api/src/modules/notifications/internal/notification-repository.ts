import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type {
  NotificationRecord,
  CustomerNotificationPreference,
  NotificationStatus,
  NotificationType,
  NotificationChannel,
} from './notification-models.js';

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
    notificationType: row.notification_type as NotificationType,
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

export class NotificationRepository {
  async findCustomerPreferences(
    db: DatabaseConnection,
    tenantId: string,
    customerId: string,
  ): Promise<CustomerNotificationPreference | null> {
    const res = await db.query<{
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

    const disabledTypes = row.disabled_types
      ? (row.disabled_types.split(',').filter(Boolean) as NotificationType[])
      : [];

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

  async upsertCustomerPreferences(
    db: DatabaseConnection,
    pref: {
      id: string;
      tenantId: string;
      customerId: string;
      emailEnabled: boolean;
      smsEnabled: boolean;
      pushEnabled: boolean;
      disabledTypes: NotificationType[];
    },
  ): Promise<void> {
    const disabledStr = pref.disabledTypes.join(',');
    const existing = await this.findCustomerPreferences(db, pref.tenantId, pref.customerId);

    if (existing) {
      await db.query(
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
      await db.query(
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

  async findNotificationByIdempotencyKey(
    db: DatabaseConnection,
    idempotencyKey: string,
  ): Promise<NotificationRecord | null> {
    const res = await db.query<RawNotificationRow>(
      `SELECT * FROM notifications WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = res.rows[0];
    return row ? mapRowToNotificationRecord(row) : null;
  }

  async insertNotification(db: DatabaseConnection, n: NotificationRecord): Promise<void> {
    await db.query(
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

  async claimPendingNotifications(
    db: DatabaseConnection,
    batchSize: number,
  ): Promise<NotificationRecord[]> {
    return db.withTransaction(async (tx) => {
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

  async markSent(db: DatabaseConnection, id: string): Promise<void> {
    await db.query(
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
    db: DatabaseConnection,
    id: string,
    error: string,
    nextAvailableAt: Date | null,
    deadLetter: boolean,
  ): Promise<void> {
    if (deadLetter) {
      await db.query(
        `UPDATE notifications
         SET status = 'DEAD_LETTERED',
             last_error = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [error, id],
      );
    } else {
      await db.query(
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

  async getNotificationById(
    db: DatabaseConnection,
    id: string,
  ): Promise<NotificationRecord | null> {
    const res = await db.query<RawNotificationRow>(`SELECT * FROM notifications WHERE id = $1`, [
      id,
    ]);
    const row = res.rows[0];
    return row ? mapRowToNotificationRecord(row) : null;
  }

  async listNotifications(
    db: DatabaseConnection,
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
    const countRes = await db.query<{ count: string | number }>(
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

    const rowsRes = await db.query<RawNotificationRow>(
      `SELECT * FROM notifications ${whereClause} ORDER BY created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );

    return {
      items: rowsRes.rows.map(mapRowToNotificationRecord),
      total,
    };
  }

  async retryNotification(db: DatabaseConnection, id: string): Promise<boolean> {
    const res = await db.query(
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
}
