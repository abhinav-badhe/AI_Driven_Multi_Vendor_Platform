import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { PaymentService, IPaymentService } from '../modules/payment/index.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';

import type { AppConfig } from '../config/schema.js';

export function registerPaymentRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  paymentService: IPaymentService | PaymentService,
  config?: AppConfig | undefined,
): void {
  const authenticate = createAuthMiddleware(identityService);

  // GET /payments/config: Public payment gateway client configuration
  app.get('/payments/config', async (_request, reply) => {
    const provider = config?.payment?.provider ?? 'razorpay';
    return reply.status(200).send({
      provider,
      razorpayKeyId: config?.payment?.razorpayKeyId || (provider === 'razorpay' ? 'rzp_test_mockKey123' : null),
      stripePublishableKey: config?.payment?.publishableKey || null,
      currency: 'INR',
    });
  });

  // POST /payments/intents: Create payment intent for a READY checkout
  app.post(
    '/payments/intents',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const body = (request.body as {
        checkoutSessionId?: unknown;
        idempotencyKey?: unknown;
        metadata?: unknown;
      } | undefined) ?? {};

      if (typeof body.checkoutSessionId !== 'string') {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'checkoutSessionId is required',
          },
        });
      }

      const intent = await paymentService.createPaymentIntent(actor, {
        checkoutSessionId: body.checkoutSessionId,
        idempotencyKey:
          typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
        metadata:
          typeof body.metadata === 'object' && body.metadata !== null
            ? (body.metadata as Record<string, unknown>)
            : undefined,
      });

      return reply.status(201).send(intent);
    },
  );

  // GET /payments/intents/:id: Retrieve payment intent details
  app.get(
    '/payments/intents/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };

      const intent = await paymentService.getPaymentIntent(actor, id);
      return reply.status(200).send(intent);
    },
  );

  // POST /payments/intents/:id/attempts: Submit payment attempt
  app.post(
    '/payments/intents/:id/attempts',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = (request.body as {
        paymentMethod?: unknown;
        idempotencyKey?: unknown;
      } | undefined) ?? {};

      const attempt = await paymentService.createPaymentAttempt(actor, id, {
        paymentMethod:
          typeof body.paymentMethod === 'string' ? body.paymentMethod : undefined,
        idempotencyKey:
          typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
      });

      return reply.status(200).send(attempt);
    },
  );

  // POST /payments/intents/:id/refund: Create refund for a succeeded payment
  app.post(
    '/payments/intents/:id/refund',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const body = (request.body as {
        amount?: unknown;
        reason?: unknown;
        idempotencyKey?: unknown;
      } | undefined) ?? {};

      const refund = await paymentService.createRefund(actor, id, {
        amount: typeof body.amount === 'number' ? body.amount : undefined,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
        idempotencyKey:
          typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
      });

      return reply.status(201).send(refund);
    },
  );

  // POST /payments/webhooks/:provider: Webhook endpoint for asynchronous provider verification
  app.post(
    '/payments/webhooks/:provider',
    async (request, reply) => {
      const { provider } = request.params as { provider: string };
      const signatureHeader =
        (request.headers['x-webhook-signature'] as string) ||
        (request.headers['stripe-signature'] as string) ||
        '';

      const rawBody =
        typeof request.body === 'string'
          ? request.body
          : JSON.stringify(request.body ?? {});

      const result = await paymentService.processWebhook(
        provider,
        rawBody,
        signatureHeader,
      );

      return reply.status(200).send({
        received: true,
        ...result,
      });
    },
  );

  // PATCH /payments/intents/:id/order: Associate finalized order with payment intent
  app.patch(
    '/payments/intents/:id/order',
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body as { orderId?: unknown } | undefined) ?? {};

      if (typeof body.orderId !== 'string') {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'orderId is required',
          },
        });
      }

      await paymentService.linkOrderToIntent(id, body.orderId);
      return reply.status(200).send({ linked: true });
    },
  );

  // GET /admin/payments: List platform payment transactions for administrator
  app.get(
    '/admin/payments',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      if (actor.role !== 'ADMINISTRATOR') {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Administrator role required',
          },
        });
      }

      const list = await paymentService.listAllPayments(actor);
      const payments = list.map((p) => ({
        ...p,
        method: p.paymentMethod ?? p.provider,
      }));

      return reply.status(200).send({ payments });
    },
  );
}

