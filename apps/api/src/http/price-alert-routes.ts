import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { PriceAlertService } from '../modules/price-alerts/index.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';
import { ForbiddenError } from '../errors/app-error.js';

export function registerPriceAlertRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  priceAlertService: PriceAlertService,
): void {
  const authenticate = createAuthMiddleware(identityService);

  // POST /products/:id/views — records a customer product view (interest signal).
  app.post(
    '/products/:id/views',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = (request.body as {
        priceSeenMinor?: unknown;
        currency?: unknown;
      } | undefined) ?? {};

      const result = await priceAlertService.recordView(
        actor,
        id,
        typeof body.priceSeenMinor === 'number' ? body.priceSeenMinor : null,
        typeof body.currency === 'string' ? body.currency : null,
      );
      return reply.status(200).send(result);
    },
  );

  // GET /price-alerts/mine — customer's watched products.
  app.get(
    '/price-alerts/mine',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const watches = await priceAlertService.listMyWatches(actor);
      return reply.status(200).send(watches);
    },
  );

  // DELETE /price-alerts/watches/:productId — stop alerts for a product.
  app.delete(
    '/price-alerts/watches/:productId',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { productId } = request.params as { productId: string };
      const result = await priceAlertService.unsubscribe(actor, productId);
      return reply.status(200).send(result);
    },
  );

  // POST /price-alerts/sweep — admin scan for missed drops.
  app.post(
    '/price-alerts/sweep',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      if (actor.role !== 'ADMINISTRATOR') {
        throw new ForbiddenError('Only platform administrators can run the price-drop sweep');
      }
      const body = (request.body as { sinceDays?: unknown } | undefined) ?? {};
      const sinceDays =
        typeof body.sinceDays === 'number' && body.sinceDays > 0 && body.sinceDays <= 365
          ? body.sinceDays
          : 90;
      const result = await priceAlertService.sweepAll(sinceDays);
      return reply.status(200).send(result);
    },
  );
}
