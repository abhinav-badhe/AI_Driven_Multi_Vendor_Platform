import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { OrderService, SellerOrderStatus } from '../modules/orders/index.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';

export function registerOrderRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  orderService: OrderService,
): void {
  const authenticate = createAuthMiddleware(identityService);

  // POST /orders: Finalize Customer Order and Seller Orders from READY checkout + SUCCEEDED payment
  app.post(
    '/orders',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const body = (request.body as {
        checkoutSessionId?: unknown;
        paymentIntentId?: unknown;
        idempotencyKey?: unknown;
      } | undefined) ?? {};

      if (typeof body.checkoutSessionId !== 'string') {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'checkoutSessionId is required',
          },
        });
      }

      if (typeof body.paymentIntentId !== 'string') {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'paymentIntentId is required',
          },
        });
      }

      const order = await orderService.createOrderFromCheckout(actor, {
        checkoutSessionId: body.checkoutSessionId,
        paymentIntentId: body.paymentIntentId,
        idempotencyKey:
          typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
      });

      return reply.status(201).send(order);
    },
  );

  // GET /orders: List Customer Orders for authenticated customer
  app.get(
    '/orders',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const query = (request.query as {
        limit?: string;
        offset?: string;
      } | undefined) ?? {};

      const limit = query.limit ? parseInt(query.limit, 10) : undefined;
      const offset = query.offset ? parseInt(query.offset, 10) : undefined;

      const orders = await orderService.listCustomerOrders(actor, { limit, offset });
      return reply.status(200).send(orders);
    },
  );

  // GET /orders/:id: Retrieve Customer Order by ID
  app.get(
    '/orders/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };

      const order = await orderService.getCustomerOrder(actor, id);
      return reply.status(200).send(order);
    },
  );

  // GET /seller/orders: List Seller Orders for authenticated merchant
  app.get(
    '/seller/orders',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const query = (request.query as {
        limit?: string;
        offset?: string;
      } | undefined) ?? {};

      const limit = query.limit ? parseInt(query.limit, 10) : undefined;
      const offset = query.offset ? parseInt(query.offset, 10) : undefined;

      const orders = await orderService.listSellerOrders(actor, { limit, offset });
      return reply.status(200).send(orders);
    },
  );

  // GET /seller/orders/:id: Retrieve Seller Order by ID
  app.get(
    '/seller/orders/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };

      const order = await orderService.getSellerOrder(actor, id);
      return reply.status(200).send(order);
    },
  );

  // PATCH /seller/orders/:id/status: Merchant updates their Seller Order status
  app.patch(
    '/seller/orders/:id/status',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = (request.body as {
        status?: unknown;
      } | undefined) ?? {};

      if (typeof body.status !== 'string') {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'status is required',
          },
        });
      }

      const order = await orderService.updateSellerOrderStatus(
        actor,
        id,
        body.status as SellerOrderStatus,
      );

      return reply.status(200).send(order);
    },
  );
}
