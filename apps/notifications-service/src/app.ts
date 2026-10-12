import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { NotificationsConfig } from './config/index.js';
import { DatabaseConnection, PostgresPoolConnection } from './infra/database/connection.js';
import { NotificationRepository } from './repository/notification-repository.js';
import { NotificationService } from './domain/notification-service.js';
import {
  EmailChannelProvider,
  SmsChannelProvider,
  PushChannelProvider,
  ResendEmailProvider,
  InMemoryEmailProvider,
  InMemorySmsProvider,
  InMemoryPushProvider,
} from './channels/index.js';
import { HmacTokenVerifier, ITokenVerifier } from './auth/token-verifier.js';
import { createAuthMiddleware } from './auth/auth-middleware.js';
import { createInternalAuthMiddleware } from './auth/internal-auth.js';
import { errorHandler } from './errors/handler.js';
import { registerHealthRoutes } from './http/routes/health-routes.js';
import { registerNotificationRoutes } from './http/routes/notification-routes.js';
import { registerPreferenceRoutes } from './http/routes/preference-routes.js';
import { registerInternalRoutes } from './http/routes/internal-routes.js';
import { NotificationEventConsumer } from './events/notification-event-consumer.js';

export interface NotificationsAppDependencies {
  config: NotificationsConfig;
  db?: DatabaseConnection;
  repository?: NotificationRepository;
  emailProvider?: EmailChannelProvider;
  smsProvider?: SmsChannelProvider;
  pushProvider?: PushChannelProvider;
  tokenVerifier?: ITokenVerifier;
  notificationService?: NotificationService;
  eventConsumer?: NotificationEventConsumer;
}

export function buildApp(dependencies: NotificationsAppDependencies): FastifyInstance {
  const { config } = dependencies;

  const app = Fastify({
    logger: false,
  });

  app.register(cors, {
    origin: true,
    credentials: true,
  });

  app.setErrorHandler(errorHandler);

  // Persistence
  const db =
    dependencies.db ??
    new PostgresPoolConnection(
      config.database.url ? { connectionString: config.database.url } : config.database,
    );
  const repository = dependencies.repository ?? new NotificationRepository(db);

  // Channel Providers
  const emailProvider =
    dependencies.emailProvider ??
    (config.channels.resendApiKey
      ? new ResendEmailProvider(config.channels.resendApiKey, config.channels.emailFrom)
      : new InMemoryEmailProvider());

  const smsProvider = dependencies.smsProvider ?? new InMemorySmsProvider();
  const pushProvider = dependencies.pushProvider ?? new InMemoryPushProvider();

  // Domain Service
  const notificationService =
    dependencies.notificationService ??
    new NotificationService(
      repository,
      {
        email: emailProvider,
        sms: smsProvider,
        push: pushProvider,
      },
      undefined,
      {
        maxRetries: config.processing.maxAttempts,
        initialRetryDelayMs: config.processing.baseRetryDelayMs,
      },
    );

  // Authentication Boundary
  const tokenVerifier = dependencies.tokenVerifier ?? new HmacTokenVerifier(config.auth.jwtSecret);
  const authMiddleware = createAuthMiddleware(tokenVerifier);
  const internalAuthMiddleware = createInternalAuthMiddleware(config.auth.internalServiceKey);

  // Event Consumer
  const eventConsumer =
    dependencies.eventConsumer ??
    new NotificationEventConsumer(notificationService, repository, undefined, {
      staleTimeoutMs: config.processing.consumerReceiptStaleTimeoutMs,
    });

  // Register Routes
  registerHealthRoutes(app, db);
  registerNotificationRoutes(app, notificationService, authMiddleware);
  registerPreferenceRoutes(app, notificationService, authMiddleware);
  registerInternalRoutes(app, notificationService, internalAuthMiddleware, eventConsumer);

  return app;
}
