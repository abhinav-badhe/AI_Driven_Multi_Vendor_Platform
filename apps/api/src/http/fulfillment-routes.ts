import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type {
  FulfillmentService,
  ShipmentStatus,
  ReturnStatus,
  CreateShipmentItemInput,
  CreateReturnItemInput,
} from '../modules/fulfillment/index.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';

export function registerFulfillmentRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  fulfillmentService: FulfillmentService,
): void {
  const authenticate = createAuthMiddleware(identityService);

  // POST /fulfillment/shipments: Create fulfillment shipment for seller order
  app.post(
    '/fulfillment/shipments',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const body = (request.body as {
        sellerOrderId?: unknown;
        items?: unknown;
        carrier?: unknown;
        trackingNumber?: unknown;
        trackingUrl?: unknown;
        idempotencyKey?: unknown;
      } | undefined) ?? {};

      if (typeof body.sellerOrderId !== 'string') {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'sellerOrderId is required',
          },
        });
      }

      if (!Array.isArray(body.items) || body.items.length === 0) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'items array is required and must not be empty',
          },
        });
      }

      const shipment = await fulfillmentService.createShipment(actor, {
        sellerOrderId: body.sellerOrderId,
        items: body.items as CreateShipmentItemInput[],
        carrier: typeof body.carrier === 'string' ? body.carrier : undefined,
        trackingNumber: typeof body.trackingNumber === 'string' ? body.trackingNumber : undefined,
        trackingUrl: typeof body.trackingUrl === 'string' ? body.trackingUrl : undefined,
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
      });

      return reply.status(201).send(shipment);
    },
  );

  // GET /fulfillment/shipments/:id
  app.get(
    '/fulfillment/shipments/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const params = request.params as { id: string };
      const shipment = await fulfillmentService.getShipment(actor, params.id);
      return reply.status(200).send(shipment);
    },
  );

  // GET /fulfillment/shipments
  app.get(
    '/fulfillment/shipments',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const query = (request.query as {
        sellerOrderId?: string | undefined;
        customerOrderId?: string | undefined;
      } | undefined) ?? {};

      const shipments = await fulfillmentService.listShipments(actor, query);
      return reply.status(200).send(shipments);
    },
  );

  // POST /fulfillment/shipments/:id/status
  app.post(
    '/fulfillment/shipments/:id/status',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const params = request.params as { id: string };
      const body = (request.body as { status?: unknown } | undefined) ?? {};

      if (typeof body.status !== 'string') {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'status is required',
          },
        });
      }

      const updated = await fulfillmentService.updateShipmentStatus(
        actor,
        params.id,
        body.status as ShipmentStatus,
      );
      return reply.status(200).send(updated);
    },
  );

  // POST /fulfillment/shipments/:id/tracking
  app.post(
    '/fulfillment/shipments/:id/tracking',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const params = request.params as { id: string };
      const body = (request.body as {
        carrier?: unknown;
        trackingNumber?: unknown;
        trackingUrl?: unknown;
      } | undefined) ?? {};

      if (typeof body.carrier !== 'string' || typeof body.trackingNumber !== 'string') {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'carrier and trackingNumber are required',
          },
        });
      }

      const updated = await fulfillmentService.updateShipmentTracking(actor, params.id, {
        carrier: body.carrier,
        trackingNumber: body.trackingNumber,
        trackingUrl: typeof body.trackingUrl === 'string' ? body.trackingUrl : undefined,
      });
      return reply.status(200).send(updated);
    },
  );

  // POST /fulfillment/returns: Customer creates return request
  app.post(
    '/fulfillment/returns',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const body = (request.body as {
        customerOrderId?: unknown;
        sellerOrderId?: unknown;
        reason?: unknown;
        items?: unknown;
        idempotencyKey?: unknown;
      } | undefined) ?? {};

      if (
        typeof body.customerOrderId !== 'string' ||
        typeof body.sellerOrderId !== 'string' ||
        typeof body.reason !== 'string'
      ) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'customerOrderId, sellerOrderId, and reason are required',
          },
        });
      }

      if (!Array.isArray(body.items) || body.items.length === 0) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'items array is required and must not be empty',
          },
        });
      }

      const ret = await fulfillmentService.createReturnRequest(actor, {
        customerOrderId: body.customerOrderId,
        sellerOrderId: body.sellerOrderId,
        reason: body.reason,
        items: body.items as CreateReturnItemInput[],
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
      });

      return reply.status(201).send(ret);
    },
  );

  // GET /fulfillment/returns/:id
  app.get(
    '/fulfillment/returns/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const params = request.params as { id: string };
      const ret = await fulfillmentService.getReturn(actor, params.id);
      return reply.status(200).send(ret);
    },
  );

  // GET /fulfillment/returns
  app.get(
    '/fulfillment/returns',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const query = (request.query as {
        customerOrderId?: string | undefined;
        sellerOrderId?: string | undefined;
      } | undefined) ?? {};

      const returns = await fulfillmentService.listReturns(actor, query);
      return reply.status(200).send(returns);
    },
  );

  // POST /fulfillment/returns/:id/status
  app.post(
    '/fulfillment/returns/:id/status',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const params = request.params as { id: string };
      const rawBody = (request.body as Record<string, unknown> | undefined) ?? {};
      const optionsObj = (typeof rawBody.options === 'object' && rawBody.options !== null)
        ? (rawBody.options as Record<string, unknown>)
        : {};

      if (typeof rawBody.status !== 'string') {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'status is required',
          },
        });
      }

      const restock = optionsObj.restock === true || rawBody.restock === true;
      const restockCondition =
        (optionsObj.restockCondition ?? rawBody.restockCondition) === 'DEFECTIVE'
          ? 'DEFECTIVE'
          : 'SELLABLE';

      const updated = await fulfillmentService.updateReturnStatus(
        actor,
        params.id,
        rawBody.status as ReturnStatus,
        {
          restock,
          restockCondition,
        },
      );

      return reply.status(200).send(updated);
    },
  );

  // POST /fulfillment/carrier/callback (Trusted Provider Callback Boundary)
  app.post(
    '/fulfillment/carrier/callback',
    async (request, reply) => {
      const rawBody =
        typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
      const signature = (request.headers['x-carrier-signature'] as string) ?? '';

      const result = await fulfillmentService.handleCarrierCallback(rawBody, signature);
      return reply.status(200).send(result);
    },
  );
}
