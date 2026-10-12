import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { OutboxService, IOutboxService } from '../modules/events/index.js';
import type { NotificationService, INotificationClient } from '../modules/notifications/index.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';
import {
  ForbiddenError,
  ValidationError,
  NotificationsExternallyManagedError,
} from '../errors/app-error.js';

export function registerEventAndNotificationRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  outboxService: IOutboxService | OutboxService,
  notificationService?: NotificationService | null,
  notificationClient?: INotificationClient | null,
  clientMode: 'local' | 'http' = 'local',
): void {
  const authenticate = createAuthMiddleware(identityService);

  // 1. GET /events/outbox (Admin Outbox Listing)
  app.get('/events/outbox', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can inspect outbox events');
    }

    const query = request.query as Record<string, string | undefined>;
    const limit = query.limit ? Number(query.limit) : undefined;
    const offset = query.offset ? Number(query.offset) : undefined;

    const result = await outboxService.listEvents(actor, {
      status: query.status,
      tenantId: query.tenantId,
      eventType: query.eventType,
      limit,
      offset,
    });

    return reply.status(200).send(result);
  });

  // 2. GET /events/outbox/:eventId (Admin Outbox Details)
  app.get('/events/outbox/:eventId', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can inspect outbox events');
    }

    const { eventId } = request.params as { eventId: string };
    const event = await outboxService.getEventById(actor, eventId);
    return reply.status(200).send(event);
  });

  // 3. POST /events/outbox/:eventId/replay (Admin Replay)
  app.post(
    '/events/outbox/:eventId/replay',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      if (actor.role !== 'ADMINISTRATOR') {
        throw new ForbiddenError('Only platform administrators can replay outbox events');
      }

      const { eventId } = request.params as { eventId: string };
      const result = await outboxService.replayEvent(actor, eventId);
      return reply.status(200).send(result);
    },
  );

  // 4. POST /events/outbox/process (Admin Process Trigger)
  app.post('/events/outbox/process', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can trigger outbox processing');
    }

    const body = (request.body as Record<string, unknown>) || {};
    const batchSize = typeof body.batchSize === 'number' ? body.batchSize : 50;

    const result = await outboxService.publishPendingEvents({ batchSize });
    return reply.status(200).send(result);
  });

  // 5. GET /notifications (Admin Notification Listing)
  app.get('/notifications', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can list notifications');
    }

    if (clientMode === 'http' || !notificationService) {
      throw new NotificationsExternallyManagedError('GET /notifications');
    }

    const query = request.query as Record<string, string | undefined>;
    const limit = query.limit ? Number(query.limit) : undefined;
    const offset = query.offset ? Number(query.offset) : undefined;

    const result = await notificationService.listNotifications(actor, {
      tenantId: query.tenantId,
      status: query.status,
      channel: query.channel,
      limit,
      offset,
    });

    return reply.status(200).send(result);
  });

  // 6. GET /notifications/:id (Admin Notification Details)
  app.get('/notifications/:id', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can inspect notification records');
    }

    if (clientMode === 'http' || !notificationService) {
      throw new NotificationsExternallyManagedError('GET /notifications/:id');
    }

    const { id } = request.params as { id: string };
    const n = await notificationService.getNotificationById(actor, id);
    return reply.status(200).send(n);
  });

  // 7. POST /notifications/:id/retry (Admin Notification Retry)
  app.post('/notifications/:id/retry', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can retry notifications');
    }

    if (clientMode === 'http' || !notificationService) {
      throw new NotificationsExternallyManagedError('POST /notifications/:id/retry');
    }

    const { id } = request.params as { id: string };
    const result = await notificationService.retryNotification(actor, id);
    return reply.status(200).send(result);
  });

  // 8. POST /notifications/process (Admin Notification Process Trigger)
  app.post('/notifications/process', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can trigger notification processing');
    }

    const body = (request.body as Record<string, unknown>) || {};
    const batchSize = typeof body.batchSize === 'number' ? body.batchSize : 50;

    if (clientMode === 'http') {
      if (!notificationClient) {
        throw new NotificationsExternallyManagedError('POST /notifications/process');
      }
      const result = await notificationClient.processPendingNotifications({ batchSize });
      return reply.status(200).send(result);
    }

    if (!notificationService) {
      throw new NotificationsExternallyManagedError('POST /notifications/process');
    }

    const result = await notificationService.processPendingNotifications({ batchSize });
    return reply.status(200).send(result);
  });

  // 9. GET /customers/me/notification-preferences
  app.get(
    '/customers/me/notification-preferences',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const tenantId = actor.tenantId;
      const customerId = actor.userId;

      if (clientMode === 'http' || !notificationService) {
        throw new NotificationsExternallyManagedError('GET /customers/me/notification-preferences');
      }

      const pref = await notificationService.getCustomerPreferences(tenantId, customerId);
      return reply.status(200).send(
        pref ?? {
          tenantId,
          customerId,
          emailEnabled: true,
          smsEnabled: true,
          pushEnabled: true,
          disabledTypes: [],
        },
      );
    },
  );

  // 10. PUT /customers/me/notification-preferences
  app.put(
    '/customers/me/notification-preferences',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const tenantId = actor.tenantId;
      const customerId = actor.userId;

      const body = request.body as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ValidationError('Request body must be a valid object');
      }

      if (body.disabledTypes !== undefined && !Array.isArray(body.disabledTypes)) {
        throw new ValidationError('disabledTypes must be an array');
      }
      if (body.emailEnabled !== undefined && typeof body.emailEnabled !== 'boolean') {
        throw new ValidationError('emailEnabled must be a boolean');
      }
      if (body.smsEnabled !== undefined && typeof body.smsEnabled !== 'boolean') {
        throw new ValidationError('smsEnabled must be a boolean');
      }
      if (body.pushEnabled !== undefined && typeof body.pushEnabled !== 'boolean') {
        throw new ValidationError('pushEnabled must be a boolean');
      }

      if (clientMode === 'http' || !notificationService) {
        throw new NotificationsExternallyManagedError('PUT /customers/me/notification-preferences');
      }

      const updated = await notificationService.setCustomerPreferences(tenantId, customerId, {
        emailEnabled: typeof body.emailEnabled === 'boolean' ? body.emailEnabled : undefined,
        smsEnabled: typeof body.smsEnabled === 'boolean' ? body.smsEnabled : undefined,
        pushEnabled: typeof body.pushEnabled === 'boolean' ? body.pushEnabled : undefined,
        disabledTypes: Array.isArray(body.disabledTypes) ? body.disabledTypes : undefined,
      });

      return reply.status(200).send(updated);
    },
  );

  // 11. POST /events/consumers/:consumerName/reset-receipts (Admin Projection Recovery)
  app.post(
    '/events/consumers/:consumerName/reset-receipts',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      if (actor.role !== 'ADMINISTRATOR') {
        throw new ForbiddenError('Only platform administrators can reset consumer receipts');
      }

      const { consumerName } = request.params as { consumerName: string };
      const result = await outboxService.resetConsumerReceipts(actor, consumerName);
      return reply.status(200).send(result);
    },
  );
}
