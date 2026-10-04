import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { RecommendationService } from '../modules/recommendations/index.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';
import { ForbiddenError, ValidationError } from '../errors/app-error.js';

export function registerRecommendationRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  recommendationService: RecommendationService,
): void {
  const authenticate = createAuthMiddleware(identityService);

  // 1. GET /recommendations & GET /recommendations/personalized (Personalized customer recommendations)
  const handlePersonalized = async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = requireActor(request);
    const query = (request.query as Record<string, string | undefined>) || {};
    const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined;

    const options = limit !== undefined
      ? { limit, correlationId: request.correlationId }
      : { correlationId: request.correlationId };

    const result = await recommendationService.getPersonalizedRecommendations(actor, options);
    return reply.status(200).send(result);
  };

  app.get('/recommendations', { preHandler: authenticate }, handlePersonalized);
  app.get('/recommendations/personalized', { preHandler: authenticate }, handlePersonalized);

  // 2. GET /recommendations/similar/:productId (Deterministic similar products)
  app.get(
    '/recommendations/similar/:productId',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const params = request.params as { productId: string };
      const query = (request.query as Record<string, string | undefined>) || {};
      const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined;

      const options = limit !== undefined
        ? { limit, correlationId: request.correlationId }
        : { correlationId: request.correlationId };

      const result = await recommendationService.getSimilarProducts(actor, params.productId, options);
      return reply.status(200).send(result);
    },
  );

  // 3. GET /recommendations/trending (Trending products in tenant)
  app.get(
    '/recommendations/trending',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const query = (request.query as Record<string, string | undefined>) || {};
      const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined;

      const options = limit !== undefined
        ? { limit, correlationId: request.correlationId }
        : { correlationId: request.correlationId };

      const result = await recommendationService.getTrendingRecommendations(actor, options);
      return reply.status(200).send(result);
    },
  );

  // 4. GET /recommendations/frequently-bought-together/:productId (Co-purchased items)
  app.get(
    '/recommendations/frequently-bought-together/:productId',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const params = request.params as { productId: string };
      const query = (request.query as Record<string, string | undefined>) || {};
      const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined;

      const options = limit !== undefined
        ? { limit, correlationId: request.correlationId }
        : { correlationId: request.correlationId };

      const result = await recommendationService.getFrequentlyBoughtTogether(
        actor,
        params.productId,
        options,
      );

      return reply.status(200).send(result);
    },
  );

  // 5. POST /recommendations/rebuild (Administrative Rebuild)
  app.post(
    '/recommendations/rebuild',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      if (actor.role !== 'ADMINISTRATOR') {
        throw new ForbiddenError('Only platform administrators can trigger recommendation rebuild');
      }

      const body = (request.body as Record<string, unknown>) || {};
      const targetTenantId = (body.tenantId as string) || actor.tenantId;
      if (!targetTenantId) {
        throw new ValidationError('tenantId is required for recommendation rebuild');
      }

      const result = await recommendationService.rebuildRecommendations(actor, targetTenantId);
      return reply.status(200).send(result);
    },
  );
}
