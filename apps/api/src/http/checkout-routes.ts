import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { CheckoutService, ICheckoutService } from '../modules/cart-checkout/index.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';

export function registerCheckoutRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  checkoutService: ICheckoutService | CheckoutService,
): void {
  const authenticate = createAuthMiddleware(identityService);

  // POST /checkout/sessions: Create checkout session from active cart
  app.post(
    '/checkout/sessions',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const body = (request.body as {
        idempotencyKey?: unknown;
        expiresInMinutes?: unknown;
        addressId?: unknown;
        shippingAddress?: unknown;
      } | undefined) ?? {};

      const session = await checkoutService.createCheckoutSession(actor, {
        idempotencyKey:
          typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
        expiresInMinutes:
          typeof body.expiresInMinutes === 'number' ? body.expiresInMinutes : undefined,
        addressId:
          typeof body.addressId === 'string' ? body.addressId : undefined,
        shippingAddress:
          body.shippingAddress && typeof body.shippingAddress === 'object'
            ? (body.shippingAddress as Record<string, unknown>)
            : undefined,
      });

      return reply.status(201).send(session);
    },
  );

  // POST /checkout/sessions/:id/address: Update checkout session shipping address
  app.post(
    '/checkout/sessions/:id/address',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = (request.body as {
        addressId?: unknown;
        shippingAddress?: unknown;
      } | undefined) ?? {};

      const session = await checkoutService.setShippingAddress(actor, id, {
        addressId: typeof body.addressId === 'string' ? body.addressId : undefined,
        shippingAddress:
          body.shippingAddress && typeof body.shippingAddress === 'object'
            ? (body.shippingAddress as Record<string, unknown>)
            : undefined,
      });
      return reply.status(200).send(session);
    },
  );

  // POST /checkout/sessions/:id/reserve: Attempt inventory reservation with compensation
  app.post(
    '/checkout/sessions/:id/reserve',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };

      const session = await checkoutService.reserveCheckoutInventory(actor, id);
      return reply.status(200).send(session);
    },
  );

  // GET /checkout/sessions/:id: Retrieve checkout session by ID
  app.get(
    '/checkout/sessions/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };

      const session = await checkoutService.getCheckoutSession(actor, id);
      return reply.status(200).send(session);
    },
  );

  // POST /checkout/sessions/:id/expire: Expire checkout session
  app.post(
    '/checkout/sessions/:id/expire',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };

      const session = await checkoutService.expireCheckoutSession(actor, id);
      return reply.status(200).send(session);
    },
  );

  // POST /checkout/sessions/:id/cancel: Cancel checkout session
  app.post(
    '/checkout/sessions/:id/cancel',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };

      const session = await checkoutService.cancelCheckoutSession(actor, id);
      return reply.status(200).send(session);
    },
  );
}
