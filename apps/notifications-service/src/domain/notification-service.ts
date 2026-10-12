import { randomUUID } from 'node:crypto';
import type {
  RequestNotificationInput,
  NotificationResultDto,
  NotificationRecord,
  CustomerNotificationPreference,
} from './models.js';
import type { NotificationChannelProviders } from '../channels/channel-provider.js';
import type { NotificationRepository } from '../repository/notification-repository.js';
import { ValidationError, NotFoundError } from '../errors/app-error.js';

export interface NotificationLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

const defaultLogger: NotificationLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class NotificationService {
  private readonly logger: NotificationLogger;

  constructor(
    private readonly repo: NotificationRepository,
    private readonly channels: NotificationChannelProviders,
    logger?: NotificationLogger,
    private readonly retryConfig: {
      claimTimeoutMs?: number;
      maxRetries?: number;
      initialRetryDelayMs?: number;
    } = {},
  ) {
    this.logger = logger ?? defaultLogger;
  }

  /**
   * Request a notification to be sent.
   * Enforces customer preferences and strict database-level idempotency.
   */
  async requestNotification(input: RequestNotificationInput): Promise<NotificationResultDto> {
    const { tenantId, customerId, notificationType, channel, recipient, payload } = input;

    if (!tenantId || !notificationType || !channel || !recipient) {
      throw new ValidationError('tenantId, notificationType, channel, and recipient are mandatory');
    }

    if (!input.eventId || typeof input.eventId !== 'string' || input.eventId.trim() === '') {
      throw new ValidationError('eventId is required and must be a non-empty string');
    }

    const eventId = input.eventId.trim();
    const templateId = input.templateId ?? `tpl_${notificationType.toLowerCase()}`;
    const idempotencyKey =
      input.idempotencyKey ?? `${eventId}:${notificationType}:${recipient}:${channel}`;

    // 1. Check Customer Preferences (if customerId provided)
    if (customerId) {
      const pref = await this.repo.findCustomerPreferences(tenantId, customerId);
      if (pref) {
        if (channel === 'EMAIL' && !pref.emailEnabled) {
          return {
            notificationId: '',
            status: 'SKIPPED',
            channel,
            recipient,
            idempotencyKey,
            skipped: true,
            reason: 'CUSTOMER_EMAIL_DISABLED',
          };
        }
        if (channel === 'SMS' && !pref.smsEnabled) {
          return {
            notificationId: '',
            status: 'SKIPPED',
            channel,
            recipient,
            idempotencyKey,
            skipped: true,
            reason: 'CUSTOMER_SMS_DISABLED',
          };
        }
        if (channel === 'PUSH' && !pref.pushEnabled) {
          return {
            notificationId: '',
            status: 'SKIPPED',
            channel,
            recipient,
            idempotencyKey,
            skipped: true,
            reason: 'CUSTOMER_PUSH_DISABLED',
          };
        }
        if (pref.disabledTypes.includes(notificationType)) {
          return {
            notificationId: '',
            status: 'SKIPPED',
            channel,
            recipient,
            idempotencyKey,
            skipped: true,
            reason: 'CUSTOMER_NOTIFICATION_TYPE_DISABLED',
          };
        }
      }
    }

    // 2. Deduplication Check
    const existing = await this.repo.findNotificationByIdempotencyKey(idempotencyKey);
    if (existing) {
      return {
        notificationId: existing.id,
        status: existing.status,
        channel: existing.channel,
        recipient: existing.recipient,
        idempotencyKey: existing.idempotencyKey,
      };
    }

    // 3. Create and persist notification
    const notificationId = randomUUID();
    const maxRetries = this.retryConfig.maxRetries ?? 3;
    const notificationRecord: NotificationRecord = {
      id: notificationId,
      tenantId,
      eventId,
      notificationType,
      channel,
      recipient,
      idempotencyKey,
      templateId,
      payload: payload ?? {},
      status: 'PENDING',
      attemptCount: 0,
      maxAttempts: maxRetries,
      availableAt: new Date().toISOString(),
      sentAt: null,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      await this.repo.insertNotification(notificationRecord);
    } catch {
      // Handle race condition on UNIQUE idempotency key
      const collision = await this.repo.findNotificationByIdempotencyKey(idempotencyKey);
      if (collision) {
        return {
          notificationId: collision.id,
          status: collision.status,
          channel: collision.channel,
          recipient: collision.recipient,
          idempotencyKey: collision.idempotencyKey,
        };
      }
      throw new Error('Failed to record notification due to concurrent collision');
    }

    return {
      notificationId,
      status: 'PENDING',
      channel,
      recipient,
      idempotencyKey,
    };
  }

  /**
   * Process pending or retry-scheduled notifications and dispatch to channels.
   */
  async processPendingNotifications(
    options: { batchSize?: number; baseRetryDelayMs?: number } = {},
  ): Promise<{
    claimed: number;
    sent: number;
    failed: number;
    deadLettered: number;
    processed: number;
  }> {
    const batchSize = options.batchSize ?? 50;
    const baseRetryDelayMs =
      options.baseRetryDelayMs ?? this.retryConfig.initialRetryDelayMs ?? 1000;

    const claimedRecords = await this.repo.claimPendingNotifications(batchSize);

    let sent = 0;
    let failed = 0;
    let deadLettered = 0;

    for (const record of claimedRecords) {
      try {
        await this.dispatchToChannel(record);
        await this.repo.markSent(record.id);
        sent += 1;
      } catch (err: unknown) {
        failed += 1;
        const errorMessage = err instanceof Error ? err.message : String(err);
        const isDeadLetter = record.attemptCount >= record.maxAttempts;

        if (isDeadLetter) {
          deadLettered += 1;
          await this.repo.recordFailure(record.id, errorMessage, null, true);
        } else {
          const delayMs = baseRetryDelayMs * Math.pow(2, record.attemptCount - 1);
          const nextAvailableAt = new Date(Date.now() + delayMs);
          await this.repo.recordFailure(record.id, errorMessage, nextAvailableAt, false);
        }
      }
    }

    return {
      claimed: claimedRecords.length,
      sent,
      failed,
      deadLettered,
      processed: claimedRecords.length,
    };
  }

  private async dispatchToChannel(record: NotificationRecord): Promise<void> {
    const payload = record.payload || {};
    const subject = (payload['subject'] as string) || `Notification: ${record.notificationType}`;
    const body = (payload['body'] as string) || JSON.stringify(payload);

    switch (record.channel) {
      case 'EMAIL':
        await this.channels.email.sendEmail(record.recipient, subject, body, payload);
        break;
      case 'SMS':
        await this.channels.sms.sendSms(record.recipient, body, payload);
        break;
      case 'PUSH':
        await this.channels.push.sendPush(record.recipient, subject, body, payload);
        break;
      default:
        throw new Error(`Unsupported channel: ${record.channel}`);
    }
  }

  /**
   * Account security mail (verification, password changes) or transactional emails.
   * Dispatched synchronously and immediately through the email provider.
   * Intentionally bypasses customer marketing preferences and does not enqueue in the notifications table.
   * Preserves exact monolith INotificationClient semantics by returning the provider message ID.
   */
  async sendTransactionalEmail(
    toOrInput:
      | string
      | {
          tenantId?: string;
          recipient: string;
          subject: string;
          body: string;
          metadata?: Record<string, unknown>;
        },
    subject?: string,
    body?: string,
  ): Promise<{ providerMessageId: string }> {
    let recipient: string;
    let subj: string;
    let textBody: string;
    let metadata: Record<string, unknown> | undefined;

    if (typeof toOrInput === 'string') {
      recipient = toOrInput;
      subj = subject ?? '';
      textBody = body ?? '';
    } else {
      recipient = toOrInput.recipient;
      subj = toOrInput.subject;
      textBody = toOrInput.body;
      metadata = toOrInput.metadata;
    }

    if (!recipient || typeof recipient !== 'string' || !recipient.trim().includes('@')) {
      throw new ValidationError('Valid recipient email address is required');
    }
    if (!subj || typeof subj !== 'string' || !subj.trim()) {
      throw new ValidationError('Email subject is required');
    }
    if (!textBody || typeof textBody !== 'string' || !textBody.trim()) {
      throw new ValidationError('Email body is required');
    }

    const { providerMessageId } = await this.channels.email.sendEmail(
      recipient.trim(),
      subj.trim(),
      textBody,
      metadata,
    );

    this.logger.info('Transactional email dispatched synchronously', {
      recipient: recipient.trim(),
      subject: subj.trim(),
      providerMessageId,
    });

    return { providerMessageId };
  }

  // --- Customer Preferences ---

  async setCustomerPreferences(
    tenantId: string,
    customerId: string,
    preferences: {
      emailEnabled?: boolean | undefined;
      smsEnabled?: boolean | undefined;
      pushEnabled?: boolean | undefined;
      disabledTypes?: string[] | undefined;
    },
  ): Promise<CustomerNotificationPreference> {
    const current = await this.repo.findCustomerPreferences(tenantId, customerId);

    const emailEnabled = preferences.emailEnabled ?? current?.emailEnabled ?? true;
    const smsEnabled = preferences.smsEnabled ?? current?.smsEnabled ?? true;
    const pushEnabled = preferences.pushEnabled ?? current?.pushEnabled ?? true;
    const disabledTypes = preferences.disabledTypes ?? current?.disabledTypes ?? [];

    await this.repo.upsertCustomerPreferences({
      id: current?.id ?? randomUUID(),
      tenantId,
      customerId,
      emailEnabled,
      smsEnabled,
      pushEnabled,
      disabledTypes,
    });

    const updated = await this.repo.findCustomerPreferences(tenantId, customerId);
    return updated!;
  }

  async getCustomerPreferences(
    tenantId: string,
    customerId: string,
  ): Promise<CustomerNotificationPreference | null> {
    return this.repo.findCustomerPreferences(tenantId, customerId);
  }

  // --- Administrative Governance ---

  async listNotifications(
    filter: {
      tenantId?: string | undefined;
      status?: string | undefined;
      channel?: string | undefined;
      limit?: number | undefined;
      offset?: number | undefined;
    } = {},
  ): Promise<{ data: NotificationRecord[]; total: number; items: NotificationRecord[] }> {
    const result = await this.repo.listNotifications(filter);
    return {
      data: result.items,
      items: result.items,
      total: result.total,
    };
  }

  async getNotificationById(id: string): Promise<NotificationRecord> {
    const n = await this.repo.getNotificationById(id);
    if (!n) {
      throw new NotFoundError(`Notification '${id}' was not found`);
    }
    return n;
  }

  async retryNotification(id: string): Promise<NotificationRecord> {
    const retried = await this.repo.retryNotification(id);
    if (!retried) {
      throw new NotFoundError(`Notification '${id}' not found or not eligible for retry`);
    }
    const updated = await this.getNotificationById(id);
    return updated;
  }
}
