import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { AuthorizedActor } from '../../identity/index.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../../errors/app-error.js';
import type {
  RequestNotificationInput,
  NotificationResultDto,
  NotificationRecord,
  CustomerNotificationPreference,
  NotificationType,
} from './notification-models.js';
import type {
  EmailChannelProvider,
  SmsChannelProvider,
  PushChannelProvider,
} from './channel-providers.js';
import { NotificationRepository } from './notification-repository.js';

import type { INotificationClient } from './notification-client.js';

export class NotificationService implements INotificationClient {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly repo: NotificationRepository,
    private readonly emailProvider: EmailChannelProvider,
    private readonly smsProvider: SmsChannelProvider,
    private readonly pushProvider: PushChannelProvider,
    private readonly logger: Logger,
  ) {}

  /**
   * Request a notification to be sent.
   * Enforces customer preferences, tenant isolation, and strict database-level idempotency.
   */
  async requestNotification(input: RequestNotificationInput): Promise<NotificationResultDto> {
    const { tenantId, customerId, eventId, notificationType, channel, recipient, templateId, payload } = input;

    if (!tenantId || !eventId || !notificationType || !channel || !recipient || !templateId) {
      throw new ValidationError('All notification request fields are mandatory');
    }

    // 1. Check Customer Preferences (if customerId provided)
    if (customerId) {
      const pref = await this.repo.findCustomerPreferences(this.db, tenantId, customerId);
      if (pref) {
        if (channel === 'EMAIL' && !pref.emailEnabled) {
          this.logger.info('Notification skipped due to customer email preference opt-out', {
            tenantId,
            customerId,
            notificationType,
          });
          return {
            notificationId: '',
            status: 'PENDING',
            channel,
            recipient,
            idempotencyKey: '',
            skipped: true,
            reason: 'CUSTOMER_EMAIL_DISABLED',
          };
        }
        if (channel === 'SMS' && !pref.smsEnabled) {
          this.logger.info('Notification skipped due to customer SMS preference opt-out', {
            tenantId,
            customerId,
            notificationType,
          });
          return {
            notificationId: '',
            status: 'PENDING',
            channel,
            recipient,
            idempotencyKey: '',
            skipped: true,
            reason: 'CUSTOMER_SMS_DISABLED',
          };
        }
        if (channel === 'PUSH' && !pref.pushEnabled) {
          this.logger.info('Notification skipped due to customer push preference opt-out', {
            tenantId,
            customerId,
            notificationType,
          });
          return {
            notificationId: '',
            status: 'PENDING',
            channel,
            recipient,
            idempotencyKey: '',
            skipped: true,
            reason: 'CUSTOMER_PUSH_DISABLED',
          };
        }
        if (pref.disabledTypes.includes(notificationType)) {
          this.logger.info('Notification skipped due to customer notification type opt-out', {
            tenantId,
            customerId,
            notificationType,
          });
          return {
            notificationId: '',
            status: 'PENDING',
            channel,
            recipient,
            idempotencyKey: '',
            skipped: true,
            reason: 'CUSTOMER_NOTIFICATION_TYPE_DISABLED',
          };
        }
      }
    }

    // 2. Generate Deterministic Idempotency Key
    const idempotencyKey = `${eventId}:${notificationType}:${recipient}:${channel}`;

    // 3. Check for existing notification
    const existing = await this.repo.findNotificationByIdempotencyKey(this.db, idempotencyKey);
    if (existing) {
      this.logger.info('Duplicate notification request recognized; returning existing record', {
        idempotencyKey,
        notificationId: existing.id,
        status: existing.status,
      });
      return {
        notificationId: existing.id,
        status: existing.status,
        channel: existing.channel,
        recipient: existing.recipient,
        idempotencyKey: existing.idempotencyKey,
      };
    }

    // 4. Create and persist notification record
    const notificationId = randomUUID();
    const notificationRecord: NotificationRecord = {
      id: notificationId,
      tenantId,
      eventId,
      notificationType,
      channel,
      recipient,
      idempotencyKey,
      templateId,
      payload,
      status: 'PENDING',
      attemptCount: 0,
      maxAttempts: 3,
      availableAt: new Date().toISOString(),
      sentAt: null,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      await this.repo.insertNotification(this.db, notificationRecord);
    } catch {
      // Race condition: concurrent insert collided on UNIQUE(idempotency_key)
      const collision = await this.repo.findNotificationByIdempotencyKey(this.db, idempotencyKey);
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

    this.logger.info('Notification request recorded in PENDING state', {
      notificationId,
      tenantId,
      eventId,
      notificationType,
      channel,
      recipient,
    });

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
  ): Promise<{ claimed: number; sent: number; failed: number; deadLettered: number }> {
    const batchSize = options.batchSize ?? 50;
    const baseRetryDelayMs = options.baseRetryDelayMs ?? 1000;

    const claimedRecords = await this.repo.claimPendingNotifications(this.db, batchSize);

    let sent = 0;
    let failed = 0;
    let deadLettered = 0;

    for (const record of claimedRecords) {
      try {
        await this.dispatchToChannel(record);
        await this.repo.markSent(this.db, record.id);
        sent += 1;

        this.logger.info('Notification successfully delivered via provider', {
          notificationId: record.id,
          channel: record.channel,
          recipient: record.recipient,
        });
      } catch (err: unknown) {
        failed += 1;
        const errorMessage = err instanceof Error ? err.message : String(err);
        const isDeadLetter = record.attemptCount >= record.maxAttempts;

        if (isDeadLetter) {
          deadLettered += 1;
          await this.repo.recordFailure(this.db, record.id, errorMessage, null, true);
          this.logger.error('Notification exceeded max delivery attempts; marked DEAD_LETTERED', {
            notificationId: record.id,
            error: errorMessage,
            attemptCount: record.attemptCount,
          });
        } else {
          const delayMs = baseRetryDelayMs * Math.pow(2, record.attemptCount - 1);
          const nextAvailableAt = new Date(Date.now() + delayMs);
          await this.repo.recordFailure(this.db, record.id, errorMessage, nextAvailableAt, false);
          this.logger.warn('Notification delivery failed; scheduled for retry', {
            notificationId: record.id,
            error: errorMessage,
            attemptCount: record.attemptCount,
            nextAvailableAt: nextAvailableAt.toISOString(),
          });
        }
      }
    }

    return {
      claimed: claimedRecords.length,
      sent,
      failed,
      deadLettered,
    };
  }

  private async dispatchToChannel(record: NotificationRecord): Promise<void> {
    const subject = (record.payload.subject as string) || `Notification: ${record.notificationType}`;
    const body = (record.payload.body as string) || JSON.stringify(record.payload);

    switch (record.channel) {
      case 'EMAIL':
        await this.emailProvider.sendEmail(record.recipient, subject, body, record.payload);
        break;
      case 'SMS':
        await this.smsProvider.sendSms(record.recipient, body, record.payload);
        break;
      case 'PUSH':
        await this.pushProvider.sendPush(record.recipient, subject, body, record.payload);
        break;
      default:
        throw new Error(`Unsupported channel: ${record.channel}`);
    }
  }

  /**
   * Sends account-security mail (verification, password changes) straight
   * through the email provider. Intentionally bypasses marketing
   * preferences — these messages are required for account access.
   */
  async sendTransactionalEmail(to: string, subject: string, body: string): Promise<string> {
    const { providerMessageId } = await this.emailProvider.sendEmail(to, subject, body);
    this.logger.info('Transactional email dispatched', { to, subject, providerMessageId });
    return providerMessageId;
  }

  // --- Customer Preferences Management ---

  async setCustomerPreferences(
    tenantId: string,
    customerId: string,
    preferences: {
      emailEnabled?: boolean | undefined;
      smsEnabled?: boolean | undefined;
      pushEnabled?: boolean | undefined;
      disabledTypes?: NotificationType[] | undefined;
    },
  ): Promise<CustomerNotificationPreference> {
    const current = await this.repo.findCustomerPreferences(this.db, tenantId, customerId);

    const emailEnabled = preferences.emailEnabled ?? current?.emailEnabled ?? true;
    const smsEnabled = preferences.smsEnabled ?? current?.smsEnabled ?? true;
    const pushEnabled = preferences.pushEnabled ?? current?.pushEnabled ?? true;
    const disabledTypes = preferences.disabledTypes ?? current?.disabledTypes ?? [];

    await this.repo.upsertCustomerPreferences(this.db, {
      id: current?.id ?? randomUUID(),
      tenantId,
      customerId,
      emailEnabled,
      smsEnabled,
      pushEnabled,
      disabledTypes,
    });

    const updated = await this.repo.findCustomerPreferences(this.db, tenantId, customerId);
    return updated!;
  }

  async getCustomerPreferences(
    tenantId: string,
    customerId: string,
  ): Promise<CustomerNotificationPreference | null> {
    return this.repo.findCustomerPreferences(this.db, tenantId, customerId);
  }

  // --- Administrative Governance Operations ---

  async listNotifications(
    actor: AuthorizedActor,
    filter: {
      tenantId?: string | undefined;
      status?: string | undefined;
      channel?: string | undefined;
      limit?: number | undefined;
      offset?: number | undefined;
    } = {},
  ): Promise<{ items: NotificationRecord[]; total: number }> {
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can list notifications');
    }

    return this.repo.listNotifications(this.db, filter);
  }

  async getNotificationById(
    actor: AuthorizedActor,
    id: string,
  ): Promise<NotificationRecord> {
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can inspect notification records');
    }

    const n = await this.repo.getNotificationById(this.db, id);
    if (!n) {
      throw new NotFoundError(`Notification '${id}' was not found`);
    }
    return n;
  }

  async retryNotification(
    actor: AuthorizedActor,
    id: string,
  ): Promise<{ retried: boolean }> {
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can retry failed notifications');
    }

    const retried = await this.repo.retryNotification(this.db, id);
    if (!retried) {
      throw new NotFoundError(`Notification '${id}' not found or not eligible for retry`);
    }

    this.logger.info('Notification reset to PENDING for retry', {
      notificationId: id,
      adminUserId: actor.userId,
    });

    return { retried: true };
  }
}
