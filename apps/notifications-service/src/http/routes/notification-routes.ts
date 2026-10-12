import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { NotificationService } from '../../domain/notification-service.js';
import { ForbiddenError, UnauthorizedError } from '../../errors/app-error.js';

export function registerNotificationRoutes(
  app: FastifyInstance,
  notificationService: NotificationService,
  authMiddleware: (req: FastifyRequest, rep: FastifyReply) => Promise<void>,
) {
  // GET /notifications (Admin Notification Listing)
  app.get('/notifications', { preHandler: authMiddleware }, async (request, reply) => {
    const actor = request.actor;
    if (!actor) {
      throw new UnauthorizedError('Authentication required');
    }
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can list notifications');
    }

    const query = request.query as Record<string, string | undefined>;
    const limit = query.limit ? Number(query.limit) : undefined;
    const offset = query.offset ? Number(query.offset) : undefined;

    const result = await notificationService.listNotifications({
      tenantId: query.tenantId,
      status: query.status,
      channel: query.channel,
      limit,
      offset,
    });

    return reply.status(200).send(result);
  });

  // GET /notifications/:id (Admin Notification Details)
  app.get('/notifications/:id', { preHandler: authMiddleware }, async (request, reply) => {
    const actor = request.actor;
    if (!actor) {
      throw new UnauthorizedError('Authentication required');
    }
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can inspect notification records');
    }

    const { id } = request.params as { id: string };
    const n = await notificationService.getNotificationById(id);
    return reply.status(200).send(n);
  });

  // POST /notifications/:id/retry (Admin Notification Retry)
  app.post('/notifications/:id/retry', { preHandler: authMiddleware }, async (request, reply) => {
    const actor = request.actor;
    if (!actor) {
      throw new UnauthorizedError('Authentication required');
    }
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can retry notifications');
    }

    const { id } = request.params as { id: string };
    const result = await notificationService.retryNotification(id);
    return reply.status(200).send(result);
  });

  // POST /notifications/process (Admin Notification Process Trigger)
  app.post('/notifications/process', { preHandler: authMiddleware }, async (request, reply) => {
    const actor = request.actor;
    if (!actor) {
      throw new UnauthorizedError('Authentication required');
    }
    if (actor.role !== 'ADMINISTRATOR') {
      throw new ForbiddenError('Only platform administrators can trigger notification processing');
    }

    const body = (request.body as Record<string, unknown>) || {};
    const batchSize = typeof body.batchSize === 'number' ? body.batchSize : 50;

    const result = await notificationService.processPendingNotifications({ batchSize });
    return reply.status(200).send(result);
  });
}
