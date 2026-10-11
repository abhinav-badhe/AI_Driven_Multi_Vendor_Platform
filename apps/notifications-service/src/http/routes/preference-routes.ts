import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { NotificationService } from '../../domain/notification-service.js';
import { UnauthorizedError, ValidationError } from '../../errors/app-error.js';

export function registerPreferenceRoutes(
  app: FastifyInstance,
  notificationService: NotificationService,
  authMiddleware: (req: FastifyRequest, rep: FastifyReply) => Promise<void>,
) {
  // GET /customers/me/notification-preferences
  app.get(
    '/customers/me/notification-preferences',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const actor = request.actor;
      if (!actor) {
        throw new UnauthorizedError('Authentication required');
      }

      const tenantId = actor.tenantId;
      const customerId = actor.userId;

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

  // PUT /customers/me/notification-preferences
  app.put(
    '/customers/me/notification-preferences',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const actor = request.actor;
      if (!actor) {
        throw new UnauthorizedError('Authentication required');
      }

      const tenantId = actor.tenantId;
      const customerId = actor.userId;

      const body = request.body as Record<string, unknown>;
      if (!body || typeof body !== 'object') {
        throw new ValidationError('Request body must be a valid object');
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
}
