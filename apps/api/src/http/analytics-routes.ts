import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { AnalyticsService, TimeGranularity } from '../modules/analytics/index.js';
import type { AuthorizedActor } from '../modules/identity/index.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';
import { ValidationError } from '../errors/app-error.js';
import { CachePresets, CacheTags, cacheKey, sendCached, visibilityClass } from './cache-helper.js';

function analyticsKey(
  request: FastifyRequest,
  actor: AuthorizedActor,
  view: string,
  query: Record<string, string | undefined>,
): string {
  const parts = Object.entries(query)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  return cacheKey('analytics', view, actor.tenantId, visibilityClass(request), ...parts);
}

export function registerAnalyticsRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  analyticsService: AnalyticsService,
): void {
  const authenticate = createAuthMiddleware(identityService);

  // Cached dashboard views: aggregates refresh on every order/payment event,
  // so a short TTL + SWR keeps dashboards instant without freezing numbers.
  const sendAnalytics = async (
    request: FastifyRequest,
    reply: FastifyReply,
    view: string,
    loader: () => Promise<unknown>,
  ): Promise<void> => {
    const actor = requireActor(request);
    const query = (request.query as Record<string, string | undefined>) || {};
    return sendCached(
      app,
      request,
      reply,
      {
        key: analyticsKey(request, actor, view, query),
        tags: [CacheTags.analytics, `${CacheTags.analytics}:tenant:${actor.tenantId}`],
        preset: CachePresets.analytics,
      },
      loader,
    );
  };

  // 1. GET /analytics/sales (Commerce KPIs: Orders, Gross/Net Sales, Refunds, AOV, Trends)
  app.get('/analytics/sales', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    const query = request.query as Record<string, string | undefined>;

    return sendAnalytics(request, reply, 'sales', () =>
      analyticsService.getCommerceKpis(actor, {
        startDate: query.startDate,
        endDate: query.endDate,
        granularity: query.granularity as TimeGranularity | undefined,
        currency: query.currency,
        merchantId: query.merchantId,
        tenantId: query.tenantId,
      }),
    );
  });

  // 2. GET /analytics/merchants (Merchant-level Performance Breakdown)
  app.get('/analytics/merchants', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    const query = request.query as Record<string, string | undefined>;

    return sendAnalytics(request, reply, 'merchants', () =>
      analyticsService.getMerchantAnalytics(actor, {
        startDate: query.startDate,
        endDate: query.endDate,
        granularity: query.granularity as TimeGranularity | undefined,
        currency: query.currency,
        merchantId: query.merchantId,
        tenantId: query.tenantId,
      }),
    );
  });

  // 3. GET /analytics/products (Product-level Performance & Revenue)
  app.get('/analytics/products', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    const query = request.query as Record<string, string | undefined>;

    return sendAnalytics(request, reply, 'products', () =>
      analyticsService.getProductPerformance(actor, {
        startDate: query.startDate,
        endDate: query.endDate,
        granularity: query.granularity as TimeGranularity | undefined,
        currency: query.currency,
        merchantId: query.merchantId,
        tenantId: query.tenantId,
      }),
    );
  });

  // 4. GET /analytics/operations (Payment Success Rates, Fulfillment & Return Counts)
  app.get('/analytics/operations', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    const query = request.query as Record<string, string | undefined>;

    return sendAnalytics(request, reply, 'operations', () =>
      analyticsService.getOperationalKpis(actor, {
        startDate: query.startDate,
        endDate: query.endDate,
        granularity: query.granularity as TimeGranularity | undefined,
        currency: query.currency,
        tenantId: query.tenantId,
      }),
    );
  });

  // 5. POST /analytics/rebuild (Projection rebuild from events + order backfill)
  app.post('/analytics/rebuild', { preHandler: authenticate }, async (request, reply) => {
    const actor = requireActor(request);
    const body = (request.body as Record<string, unknown>) || {};
    // Administrators may target any tenant; merchants are scoped to their own.
    const targetTenantId =
      actor.role === 'ADMINISTRATOR' ? (body.tenantId as string) || actor.tenantId : actor.tenantId;
    if (!targetTenantId) {
      throw new ValidationError('tenantId is required for analytics rebuild');
    }

    const result = await analyticsService.rebuildProjections(actor, targetTenantId);
    await app.cache.invalidateTags(
      CacheTags.analytics,
      `${CacheTags.analytics}:tenant:${targetTenantId}`,
    );
    return reply.status(200).send(result);
  });
}
