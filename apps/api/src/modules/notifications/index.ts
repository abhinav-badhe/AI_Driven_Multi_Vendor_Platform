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
  ResendEmailProvider,
} from './internal/channel-providers.js';

import { NotificationRepository } from './internal/notification-repository.js';
import { NotificationService } from './internal/notification-service.js';
import { NotificationEventConsumer } from './internal/notification-consumer.js';
import {
  type INotificationClient,
  LocalNotificationClient,
} from './internal/notification-client.js';
import {
  HttpNotificationClient,
  HttpNotificationClientError,
  type HttpNotificationClientConfig,
  type HttpNotificationClientOptions,
} from './internal/http-notification-client.js';
import {
  HttpEventForwarder,
  HttpEventForwarderError,
  type HttpEventForwarderConfig,
  NOTIFICATION_EVENT_TYPES,
  type NotificationRelevantEventType,
  CONSUMER_NAME,
  DEFAULT_MAX_RESPONSE_BYTES,
  readBoundedText,
} from './internal/http-event-forwarder.js';

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
  INotificationClient,
  HttpNotificationClientConfig,
  HttpNotificationClientOptions,
  HttpEventForwarderConfig,
  NotificationRelevantEventType,
};

export {
  InMemoryEmailProvider,
  InMemorySmsProvider,
  InMemoryPushProvider,
  ResendEmailProvider,
  NotificationRepository,
  NotificationService,
  NotificationEventConsumer,
  LocalNotificationClient,
  HttpNotificationClient,
  HttpNotificationClientError,
  HttpEventForwarder,
  HttpEventForwarderError,
  NOTIFICATION_EVENT_TYPES,
  CONSUMER_NAME,
  DEFAULT_MAX_RESPONSE_BYTES,
  readBoundedText,
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
  createClient(service: NotificationService): INotificationClient;
  createHttpClient(config: HttpNotificationClientConfig): INotificationClient;
  createConsumer(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
    clientOrService: INotificationClient | NotificationService,
  ): NotificationEventConsumer;
  createEventForwarder(
    transport: EventTransport,
    logger: Logger,
    config: HttpEventForwarderConfig,
  ): HttpEventForwarder;
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
  createClient(service: NotificationService): INotificationClient {
    return new LocalNotificationClient(service);
  },
  createHttpClient(config: HttpNotificationClientConfig): INotificationClient {
    return new HttpNotificationClient(config);
  },
  createConsumer(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
    clientOrService: INotificationClient | NotificationService,
  ): NotificationEventConsumer {
    const outboxRepo = new OutboxRepository();
    const client: INotificationClient =
      clientOrService instanceof NotificationService
        ? new LocalNotificationClient(clientOrService)
        : clientOrService;
    const consumer = new NotificationEventConsumer(db, outboxRepo, transport, logger, client);
    consumer.registerSubscriptions();
    return consumer;
  },
  createEventForwarder(
    transport: EventTransport,
    logger: Logger,
    config: HttpEventForwarderConfig,
  ): HttpEventForwarder {
    const forwarder = new HttpEventForwarder(config, logger);
    forwarder.registerSubscriptions(transport);
    return forwarder;
  },
  createDefaultProviders() {
    return {
      emailProvider: new InMemoryEmailProvider(),
      smsProvider: new InMemorySmsProvider(),
      pushProvider: new InMemoryPushProvider(),
    };
  },
};
