import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { BackInStockService } from '../modules/customer/index.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';
import { ValidationError } from '../errors/app-error.js';

export function registerBackInStockRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  backInStockService: BackInStockService,
): void {
  const authenticate = createAuthMiddleware(identityService);
  const routePrefixes = ['', '/api/v1', '/v1'];

  for (const prefix of routePrefixes) {
    // GET /customer/back-in-stock: List customer's back-in-stock subscriptions
    app.get(
      `${prefix}/customer/back-in-stock`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const subscriptions = await backInStockService.listSubscriptions(actor);
        return reply.status(200).send(subscriptions);
      },
    );

    // POST /customer/back-in-stock: Subscribe for back-in-stock notification
    app.post(
      `${prefix}/customer/back-in-stock`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const body = request.body as {
          productId?: unknown;
          skuId?: unknown;
        };

        if (typeof body?.productId !== 'string' || !body.productId.trim()) {
          throw new ValidationError('productId is required and must be a string');
        }

        const subscription = await backInStockService.subscribe(actor, {
          productId: body.productId.trim(),
          skuId: typeof body.skuId === 'string' ? body.skuId.trim() : undefined,
        });

        return reply.status(201).send(subscription);
      },
    );

    // DELETE /customer/back-in-stock/:productId: Cancel back-in-stock subscription
    app.delete(
      `${prefix}/customer/back-in-stock/:productId`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const { productId } = request.params as { productId: string };

        const result = await backInStockService.cancelSubscription(actor, productId);
        return reply.status(200).send(result);
      },
    );

    // GET /customer/back-in-stock/check/:productId: Check if product is subscribed
    app.get(
      `${prefix}/customer/back-in-stock/check/:productId`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const { productId } = request.params as { productId: string };

        const checkResult = await backInStockService.checkSubscription(actor, productId);
        return reply.status(200).send(checkResult);
      },
    );
  }
}
