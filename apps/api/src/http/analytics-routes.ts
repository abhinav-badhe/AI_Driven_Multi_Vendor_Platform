import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { AnalyticsService, TimeGranularity } from '../modules/analytics/index.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';
import { ForbiddenError, ValidationError } from '../errors/app-error.js';

export function registerAnalyticsRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  analyticsService: AnalyticsService,
): void {
  const authenticate = createAuthMiddleware(identityService);

  // 1. GET /analytics/sales (Commerce KPIs: Orders, Gross/Net Sales, Refunds, AOV, Trends)
  app.get(
    '/analytics/sales',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const query = request.query as Record<string, string | undefined>;

      const result = await analyticsService.getCommerceKpis(actor, {
        startDate: query.startDate,
        endDate: query.endDate,
        granularity: query.granularity as TimeGranularity | undefined,
        currency: query.currency,
        merchantId: query.merchantId,
        tenantId: query.tenantId,
      });

      return reply.status(200).send(result);
    },
  );

  // 2. GET /analytics/merchants (Merchant-level Performance Breakdown)
  app.get(
    '/analytics/merchants',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const query = request.query as Record<string, string | undefined>;

      const result = await analyticsService.getMerchantAnalytics(actor, {
        startDate: query.startDate,
        endDate: query.endDate,
        granularity: query.granularity as TimeGranularity | undefined,
        currency: query.currency,
        merchantId: query.merchantId,
        tenantId: query.tenantId,
      });

      return reply.status(200).send(result);
    },
  );

  // 3. GET /analytics/products (Product-level Performance & Revenue)
  app.get(
    '/analytics/products',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const query = request.query as Record<string, string | undefined>;

      const result = await analyticsService.getProductPerformance(actor, {
        startDate: query.startDate,
        endDate: query.endDate,
        granularity: query.granularity as TimeGranularity | undefined,
        currency: query.currency,
        merchantId: query.merchantId,
        tenantId: query.tenantId,
      });

      return reply.status(200).send(result);
    },
  );

  // 4. GET /analytics/operations (Payment Success Rates, Fulfillment & Return Counts)
  app.get(
    '/analytics/operations',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const query = request.query as Record<string, string | undefined>;

      const result = await analyticsService.getOperationalKpis(actor, {
        startDate: query.startDate,
        endDate: query.endDate,
        granularity: query.granularity as TimeGranularity | undefined,
        currency: query.currency,
        tenantId: query.tenantId,
      });

      return reply.status(200).send(result);
    },
  );

  // 5. POST /analytics/rebuild (Administrative Projection Rebuild from Event Store)
  app.post(
    '/analytics/rebuild',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      if (actor.role !== 'ADMINISTRATOR') {
        throw new ForbiddenError('Only platform administrators can trigger analytics rebuild');
      }

      const body = (request.body as Record<string, unknown>) || {};
      const targetTenantId = (body.tenantId as string) || actor.tenantId;
      if (!targetTenantId) {
        throw new ValidationError('tenantId is required for analytics rebuild');
      }

      const result = await analyticsService.rebuildProjections(actor, targetTenantId);
      return reply.status(200).send(result);
    },
  );
}
