/**
 * BOUNDED CONTEXT: Notifications
 * Ownership: Notification delivery requests, channel dispatch abstractions (Email, SMS, Push),
 * customer channel preferences, notification idempotency.
 *
 * Invariant: Notifications does NOT own Order, Payment, Shipment, or Customer truth.
 */

import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { EventTransport } from '../events/index.js';
import { OutboxRepository } from '../events/index.js';

import {
  type NotificationChannel,
  type NotificationStatus,
  type NotificationType,
  type NotificationRecord,
  type CustomerNotificationPreference,
  type RequestNotificationInput,
  type NotificationResultDto,
} from './internal/notification-models.js';

import {
  type EmailChannelProvider,
  type SmsChannelProvider,
  type PushChannelProvider,
  InMemoryEmailProvider,
  InMemorySmsProvider,
  InMemoryPushProvider,
} from './internal/channel-providers.js';

import { NotificationRepository } from './internal/notification-repository.js';
import { NotificationService } from './internal/notification-service.js';
import { NotificationEventConsumer } from './internal/notification-consumer.js';

export type {
  NotificationChannel,
  NotificationStatus,
  NotificationType,
  NotificationRecord,
  CustomerNotificationPreference,
  RequestNotificationInput,
  NotificationResultDto,
  EmailChannelProvider,
  SmsChannelProvider,
  PushChannelProvider,
};

export {
  InMemoryEmailProvider,
  InMemorySmsProvider,
  InMemoryPushProvider,
  NotificationRepository,
  NotificationService,
  NotificationEventConsumer,
};

export interface NotificationModule {
  readonly contextName: 'notifications';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    emailProvider?: EmailChannelProvider,
    smsProvider?: SmsChannelProvider,
    pushProvider?: PushChannelProvider,
  ): NotificationService;
  createConsumer(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
    notificationService: NotificationService,
  ): NotificationEventConsumer;
  createDefaultProviders(): {
    emailProvider: EmailChannelProvider;
    smsProvider: SmsChannelProvider;
    pushProvider: PushChannelProvider;
  };
}

export const notificationModule: NotificationModule = {
  contextName: 'notifications',
  createService(
    db: DatabaseConnection,
    logger: Logger,
    emailProvider?: EmailChannelProvider,
    smsProvider?: SmsChannelProvider,
    pushProvider?: PushChannelProvider,
  ): NotificationService {
    const repo = new NotificationRepository();
    const defaults = this.createDefaultProviders();
    return new NotificationService(
      db,
      repo,
      emailProvider ?? defaults.emailProvider,
      smsProvider ?? defaults.smsProvider,
      pushProvider ?? defaults.pushProvider,
      logger,
    );
  },
  createConsumer(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
    notificationService: NotificationService,
  ): NotificationEventConsumer {
    const outboxRepo = new OutboxRepository();
    const consumer = new NotificationEventConsumer(db, outboxRepo, transport, logger, notificationService);
    consumer.registerSubscriptions();
    return consumer;
  },
  createDefaultProviders() {
    return {
      emailProvider: new InMemoryEmailProvider(),
      smsProvider: new InMemorySmsProvider(),
      pushProvider: new InMemoryPushProvider(),
    };
  },
};
