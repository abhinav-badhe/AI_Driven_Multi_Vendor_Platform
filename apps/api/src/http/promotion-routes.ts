import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { IPromotionPricingEngine } from '../modules/promotion-pricing/index.js';
import type { AnalyticsService } from '../modules/analytics/index.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';
import type {
  CreatePromotionInput,
  UpdatePromotionInput,
  CalculateDiscountItem,
} from '../modules/promotion-pricing/index.js';

export function registerPromotionRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  promotionService: IPromotionPricingEngine,
  analyticsService?: AnalyticsService | null,
): void {
  const authenticate = createAuthMiddleware(identityService);

  const routePrefixes = ['', '/v1', '/api/v1'];

  for (const prefix of routePrefixes) {
    // POST /promotions: Create promotion (Merchant or Admin)
    app.post(
      `${prefix}/promotions`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const body = request.body as CreatePromotionInput;
        const created = await promotionService.createPromotion(actor, body);
        return reply.status(201).send(created);
      },
    );

    // GET /promotions: List promotions (with filters)
    app.get(
      `${prefix}/promotions`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const query = (request.query as {
          merchantTenantId?: string;
          includePlatform?: string;
          status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
          limit?: string;
          offset?: string;
        }) ?? {};

        const promotions = await promotionService.listPromotions(actor, {
          merchantTenantId: query.merchantTenantId,
          includePlatform: query.includePlatform === 'true',
          status: query.status,
          limit: query.limit ? parseInt(query.limit, 10) : undefined,
          offset: query.offset ? parseInt(query.offset, 10) : undefined,
        });

        return reply.status(200).send(promotions);
      },
    );

    // GET /promotions/:id: Get promotion by ID
    app.get(
      `${prefix}/promotions/:id`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const { id } = request.params as { id: string };
        const promo = await promotionService.getPromotion(actor, id);
        return reply.status(200).send(promo);
      },
    );

    // PATCH /promotions/:id: Update promotion
    app.patch(
      `${prefix}/promotions/:id`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const { id } = request.params as { id: string };
        const body = request.body as UpdatePromotionInput;
        const updated = await promotionService.updatePromotion(actor, id, body);
        return reply.status(200).send(updated);
      },
    );

    // POST /promotions/preview: Calculate discounts preview
    app.post(
      `${prefix}/promotions/preview`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const body = request.body as {
          items: CalculateDiscountItem[];
          couponCode?: string;
          currency: string;
        };

        const result = await promotionService.previewDiscounts(actor, {
          items: body.items ?? [],
          couponCode: body.couponCode,
          currency: body.currency ?? 'USD',
        });

        return reply.status(200).send(result);
      },
    );
  }

  // Coupon Handlers for both standard API and microservice HTTP client conventions
  const applyCouponHandler = async (
    request: Parameters<Parameters<typeof app.post>[1]['handler']>[0],
    reply: Parameters<Parameters<typeof app.post>[1]['handler']>[1],
  ) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    const body = request.body as { couponCode: string };

    if (!body.couponCode || typeof body.couponCode !== 'string' || body.couponCode.trim().length === 0) {
      return reply.status(400).send({ message: 'Coupon code is required' });
    }

    const result = await promotionService.applyCouponToCheckout(actor, id, body.couponCode.trim());
    return reply.status(200).send(result);
  };

  const removeCouponHandler = async (
    request: Parameters<Parameters<typeof app.delete>[1]['handler']>[0],
    reply: Parameters<Parameters<typeof app.delete>[1]['handler']>[1],
  ) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };

    const result = await promotionService.removeCouponFromCheckout(actor, id);
    return reply.status(200).send(result);
  };

  // Register on both /checkout/sessions/:id/coupon and /v1/checkouts/:id/coupon
  app.post('/checkout/sessions/:id/coupon', { preHandler: authenticate }, applyCouponHandler);
  app.post('/v1/checkouts/:id/coupon', { preHandler: authenticate }, applyCouponHandler);

  app.delete('/checkout/sessions/:id/coupon', { preHandler: authenticate }, removeCouponHandler);
  app.delete('/v1/checkouts/:id/coupon', { preHandler: authenticate }, removeCouponHandler);

  // GET /analytics/promotions: Promotion analytics metrics
  if (analyticsService) {
    app.get(
      '/analytics/promotions',
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const query = (request.query as { merchantId?: string }) ?? {};
        const metrics = await analyticsService.getPromotionAnalytics(actor, {
          merchantId: query.merchantId,
        });
        return reply.status(200).send(metrics);
      },
    );
  }
}
