import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { MlService, ModelType } from '../modules/analytics-ml/index.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';
import { ValidationError, NotFoundError, ForbiddenError } from '../errors/app-error.js';
import {
  CachePresets,
  CacheTags,
  cacheKey,
  sendCached,
} from './cache-helper.js';

export function registerMlRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  mlService: MlService,
): void {
  const authenticate = createAuthMiddleware(identityService);

  // 1. POST /ml/train - Asynchronously trigger model training
  app.post(
    '/ml/train',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const body = (request.body as Record<string, unknown>) || {};

      const tenantId = (body.tenantId as string) || actor.tenantId;
      const modelType = body.modelType as ModelType;
      if (!modelType) {
        throw new ValidationError('modelType is required');
      }

      const job = await mlService.trainModel(actor, {
        tenantId,
        modelType,
        version: body.version as string | undefined,
        algorithm: body.algorithm as string | undefined,
        hyperparameters: body.hyperparameters as Record<string, unknown> | undefined,
        predictionHorizon: body.predictionHorizon as string | undefined,
        maxAcceptableRmse: body.maxAcceptableRmse as number | undefined,
        minAcceptableAccuracy: body.minAcceptableAccuracy as number | undefined,
        triggerType: 'MANUAL',
      });

      await app.cache.invalidateTags(CacheTags.mlSignals);
      return reply.status(202).send({
        jobId: job.id,
        tenantId: job.tenantId,
        modelType: job.modelType,
        status: job.status,
        dataSourceType: job.dataSourceType,
        startedAt: job.startedAt,
        message: 'Training job executed asynchronously',
      });
    },
  );

  // 2. POST /ml/retrain - Trigger retraining evaluation for single model
  app.post(
    '/ml/retrain',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const body = (request.body as Record<string, unknown>) || {};
      const tenantId = (body.tenantId as string) || actor.tenantId;
      const modelType = body.modelType as ModelType;

      if (!modelType) {
        throw new ValidationError('modelType is required');
      }

      const result = await mlService.retrainIfEligible(actor, tenantId, modelType);
      await app.cache.invalidateTags(CacheTags.mlSignals);
      return reply.status(200).send(result);
    },
  );

  // 2b. POST /ml/retrain/evaluate-all - Admin manual trigger of automatic retraining policies
  app.post(
    '/ml/retrain/evaluate-all',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      if (actor.role !== 'ADMINISTRATOR') {
        throw new ForbiddenError('Only administrators can evaluate all tenant retraining policies');
      }

      const results = await mlService.evaluateAllRetrainingPolicies();
      await app.cache.invalidateTags(CacheTags.mlSignals);
      return reply.status(200).send({ evaluations: results });
    },
  );

  // 3. POST /ml/models/:modelId/rollback - Rollback to previously approved model
  app.post(
    '/ml/models/:modelId/rollback',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const params = request.params as { modelId: string };
      const query = (request.query as Record<string, string | undefined>) || {};
      const tenantId = query.tenantId || actor.tenantId;

      const model = await mlService.rollbackModel(actor, tenantId, params.modelId);
      await app.cache.invalidateTags(CacheTags.mlSignals);
      return reply.status(200).send(model);
    },
  );

  // 4. GET /ml/models - List registered models
  app.get(
    '/ml/models',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const query = (request.query as Record<string, string | undefined>) || {};
      const tenantId = query.tenantId || actor.tenantId;
      const modelType = query.modelType as ModelType | undefined;

      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('ml', 'models', tenantId, modelType ?? ''),
          tags: [CacheTags.mlSignals, `${CacheTags.mlSignals}:tenant:${tenantId}`],
          preset: CachePresets.ml,
        },
        async () => ({ models: await mlService.listModels(actor, tenantId, modelType) }),
      );
    },
  );

  // 5. GET /ml/models/:modelId - Get specific model
  app.get(
    '/ml/models/:modelId',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const params = request.params as { modelId: string };
      const query = (request.query as Record<string, string | undefined>) || {};
      const tenantId = query.tenantId || actor.tenantId;

      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('ml', 'models', params.modelId, tenantId),
          tags: [CacheTags.mlSignals, `${CacheTags.mlSignals}:model:${params.modelId}`],
          preset: CachePresets.ml,
        },
        async () => {
          const model = await mlService.getModelById(actor, tenantId, params.modelId);
          if (!model) {
            throw new NotFoundError(`Model ${params.modelId} not found`);
          }
          return model;
        },
      );
    },
  );

  // 6. GET /ml/jobs - List training jobs
  app.get(
    '/ml/jobs',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const query = (request.query as Record<string, string | undefined>) || {};
      const tenantId = query.tenantId || actor.tenantId;
      const modelType = query.modelType as ModelType | undefined;

      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('ml', 'jobs', tenantId, modelType ?? ''),
          tags: [CacheTags.mlSignals, `${CacheTags.mlSignals}:tenant:${tenantId}`],
          preset: CachePresets.merchantScoped,
        },
        async () => ({ jobs: await mlService.listTrainingJobs(actor, tenantId, modelType) }),
      );
    },
  );

  // 6b. GET /ml/jobs/:jobId - Get specific training job
  // Job status flips while training runs — short TTL only.
  app.get(
    '/ml/jobs/:jobId',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const params = request.params as { jobId: string };
      const query = (request.query as Record<string, string | undefined>) || {};
      const tenantId = query.tenantId || actor.tenantId;

      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('ml', 'jobs', params.jobId, tenantId),
          tags: [CacheTags.mlSignals, `${CacheTags.mlSignals}:job:${params.jobId}`],
          preset: CachePresets.merchantScoped,
        },
        async () => {
          const job = await mlService.getTrainingJobById(actor, tenantId, params.jobId);
          if (!job) {
            throw new NotFoundError(`Training job ${params.jobId} not found`);
          }
          return job;
        },
      );
    },
  );

  // 7. GET /ml/predictions/demand/:productId - Get demand forecast
  app.get(
    '/ml/predictions/demand/:productId',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const params = request.params as { productId: string };
      const query = (request.query as Record<string, string | undefined>) || {};
      const tenantId = query.tenantId || actor.tenantId;

      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('ml', 'pred', 'demand', params.productId, tenantId),
          tags: [CacheTags.mlSignals, `${CacheTags.mlSignals}:demand:${params.productId}`],
          preset: CachePresets.ml,
        },
        async () => {
          const pred = await mlService.getDemandPrediction(actor, tenantId, params.productId);
          if (!pred) {
            return {
              productId: params.productId,
              predictedDemand: null,
              status: 'UNAVAILABLE',
              message: 'No active prediction available for product',
            };
          }
          return pred;
        },
      );
    },
  );

  // 8. GET /ml/predictions/stockout/:sku - Get stockout risk prediction
  app.get(
    '/ml/predictions/stockout/:sku',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const params = request.params as { sku: string };
      const query = (request.query as Record<string, string | undefined>) || {};
      const tenantId = query.tenantId || actor.tenantId;

      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('ml', 'pred', 'stockout', params.sku, tenantId),
          tags: [CacheTags.mlSignals, `${CacheTags.mlSignals}:stockout:${params.sku}`],
          preset: CachePresets.ml,
        },
        async () => {
          const pred = await mlService.getStockoutPrediction(actor, tenantId, params.sku);
          if (!pred) {
            return {
              sku: params.sku,
              stockoutProbability: null,
              status: 'UNAVAILABLE',
              message: 'No active prediction available for SKU',
            };
          }
          return pred;
        },
      );
    },
  );

  // 9. GET /ml/predictions/propensity/:customerId - Get customer purchase propensity
  app.get(
    '/ml/predictions/propensity/:customerId',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const params = request.params as { customerId: string };
      const query = (request.query as Record<string, string | undefined>) || {};
      const tenantId = query.tenantId || actor.tenantId;

      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('ml', 'pred', 'propensity', params.customerId, tenantId),
          tags: [CacheTags.mlSignals, `${CacheTags.mlSignals}:propensity:${params.customerId}`],
          preset: CachePresets.ml,
        },
        async () => {
          const pred = await mlService.getPropensityPrediction(actor, tenantId, params.customerId);
          if (!pred) {
            return {
              customerId: params.customerId,
              propensityProbability: null,
              status: 'UNAVAILABLE',
              message: 'No active prediction available for customer',
            };
          }
          return pred;
        },
      );
    },
  );

  // 10. GET /ml/predictions - List predictions
  app.get(
    '/ml/predictions',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const query = (request.query as Record<string, string | undefined>) || {};
      const tenantId = query.tenantId || actor.tenantId;
      const modelType = query.modelType as ModelType | undefined;
      const entityType = query.entityType as 'PRODUCT' | 'SKU' | 'CUSTOMER' | 'ORDER' | undefined;
      const entityId = query.entityId;

      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey(
            'ml',
            'predictions',
            tenantId,
            modelType ?? '',
            entityType ?? '',
            entityId ?? '',
          ),
          tags: [CacheTags.mlSignals, `${CacheTags.mlSignals}:tenant:${tenantId}`],
          preset: CachePresets.ml,
        },
        async () => ({
          predictions: await mlService.listPredictions(actor, tenantId, {
            modelType,
            entityType,
            entityId,
          }),
        }),
      );
    },
  );

  // 11. GET /ml/predictions/anomaly/:orderId - Get order anomaly assessment
  app.get(
    '/ml/predictions/anomaly/:orderId',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const params = request.params as { orderId: string };
      const query = (request.query as Record<string, string | undefined>) || {};
      const tenantId = query.tenantId || actor.tenantId;

      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('ml', 'pred', 'anomaly', params.orderId, tenantId),
          tags: [CacheTags.mlSignals, `${CacheTags.mlSignals}:anomaly:${params.orderId}`],
          preset: CachePresets.ml,
        },
        async () => {
          const pred = await mlService.getAnomalyPrediction(actor, tenantId, params.orderId);
          if (!pred) {
            return {
              orderId: params.orderId,
              anomalyProbability: null,
              status: 'UNAVAILABLE',
              message: 'No active anomaly assessment available for order',
            };
          }
          return pred;
        },
      );
    },
  );

  // 12. GET /ml/policies/:modelType - Get retraining policy for model type
  app.get(
    '/ml/policies/:modelType',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const params = request.params as { modelType: ModelType };
      const tenantId = actor.tenantId;

      return sendCached(
        app,
        request,
        reply,
        {
          key: cacheKey('ml', 'policies', params.modelType, tenantId),
          tags: [CacheTags.mlSignals, `${CacheTags.mlSignals}:policy:${params.modelType}`],
          preset: CachePresets.ml,
        },
        async () => {
          const policy = await mlService.getRetrainingPolicy(actor, tenantId, params.modelType);
          if (!policy) {
            return {
              tenantId,
              modelType: params.modelType,
              minNewOrdersThreshold: 10,
              lastTrainedOrderCount: 0,
              enabled: false,
            };
          }
          return policy;
        },
      );
    },
  );

  // 13. PUT /ml/policies/:modelType - Save/update retraining policy
  app.put(
    '/ml/policies/:modelType',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const params = request.params as { modelType: ModelType };
      const tenantId = actor.tenantId;
      const body = (request.body as Record<string, unknown>) || {};

      const policy = await mlService.saveRetrainingPolicy(actor, tenantId, params.modelType, {
        minNewOrdersThreshold: typeof body.minNewOrdersThreshold === 'number' ? body.minNewOrdersThreshold : 10,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
      });

      await app.cache.invalidateTags(
        CacheTags.mlSignals,
        `${CacheTags.mlSignals}:policy:${params.modelType}`,
      );
      return reply.status(200).send(policy);
    },
  );
}
