import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { MlService, ModelType } from '../modules/analytics-ml/index.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';
import { ValidationError, NotFoundError, ForbiddenError } from '../errors/app-error.js';

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

      const models = await mlService.listModels(actor, tenantId, modelType);
      return reply.status(200).send({ models });
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

      const model = await mlService.getModelById(actor, tenantId, params.modelId);
      if (!model) {
        throw new NotFoundError(`Model ${params.modelId} not found`);
      }
      return reply.status(200).send(model);
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

      const jobs = await mlService.listTrainingJobs(actor, tenantId, modelType);
      return reply.status(200).send({ jobs });
    },
  );

  // 6b. GET /ml/jobs/:jobId - Get specific training job
  app.get(
    '/ml/jobs/:jobId',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = requireActor(request);
      const params = request.params as { jobId: string };
      const query = (request.query as Record<string, string | undefined>) || {};
      const tenantId = query.tenantId || actor.tenantId;

      const job = await mlService.getTrainingJobById(actor, tenantId, params.jobId);
      if (!job) {
        throw new NotFoundError(`Training job ${params.jobId} not found`);
      }
      return reply.status(200).send(job);
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

      const pred = await mlService.getDemandPrediction(actor, tenantId, params.productId);
      if (!pred) {
        return reply.status(200).send({
          productId: params.productId,
          predictedDemand: null,
          status: 'UNAVAILABLE',
          message: 'No active prediction available for product',
        });
      }

      return reply.status(200).send(pred);
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

      const pred = await mlService.getStockoutPrediction(actor, tenantId, params.sku);
      if (!pred) {
        return reply.status(200).send({
          sku: params.sku,
          stockoutProbability: null,
          status: 'UNAVAILABLE',
          message: 'No active prediction available for SKU',
        });
      }

      return reply.status(200).send(pred);
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

      const pred = await mlService.getPropensityPrediction(actor, tenantId, params.customerId);
      if (!pred) {
        return reply.status(200).send({
          customerId: params.customerId,
          propensityProbability: null,
          status: 'UNAVAILABLE',
          message: 'No active prediction available for customer',
        });
      }

      return reply.status(200).send(pred);
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
      const entityType = query.entityType as 'PRODUCT' | 'SKU' | 'CUSTOMER' | undefined;
      const entityId = query.entityId;

      const predictions = await mlService.listPredictions(actor, tenantId, {
        modelType,
        entityType,
        entityId,
      });

      return reply.status(200).send({ predictions });
    },
  );
}
