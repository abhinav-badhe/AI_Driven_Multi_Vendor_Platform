import type {
  RequestNotificationInput,
  NotificationResultDto,
} from './notification-models.js';
import type { NotificationService } from './notification-service.js';

/**
 * Narrow client interface representing external capabilities exposed to other domains.
 * Other modules (PriceAlerts, BackInStock, Identity) must depend exclusively on this
 * interface rather than the concrete monolithic NotificationService.
 */
export interface INotificationClient {
  /** Enqueue an asynchronous transactional or marketing notification with idempotency enforcement */
  requestNotification(input: RequestNotificationInput): Promise<NotificationResultDto>;

  /** Immediate, synchronous delivery of security/account emails (verification, reset) */
  sendTransactionalEmail(to: string, subject: string, body: string): Promise<string>;

  /** Batch process and dispatch pending notifications to external channels */
  processPendingNotifications(options?: {
    batchSize?: number;
    baseRetryDelayMs?: number;
  }): Promise<{ claimed: number; sent: number; failed: number; deadLettered: number }>;
}

/**
 * Local in-process adapter implementing INotificationClient by delegating
 * directly to the monolithic NotificationService instance.
 *
 * Seam: In the future, this can be swapped with HttpNotificationClient pointing to
 * the standalone Notifications microservice without changing any callers.
 */
export class LocalNotificationClient implements INotificationClient {
  constructor(private readonly notificationService: NotificationService) {}

  async requestNotification(input: RequestNotificationInput): Promise<NotificationResultDto> {
    return this.notificationService.requestNotification(input);
  }

  async sendTransactionalEmail(to: string, subject: string, body: string): Promise<string> {
    return this.notificationService.sendTransactionalEmail(to, subject, body);
  }

  async processPendingNotifications(options?: {
    batchSize?: number;
    baseRetryDelayMs?: number;
  }): Promise<{ claimed: number; sent: number; failed: number; deadLettered: number }> {
    return this.notificationService.processPendingNotifications(options);
  }
}
