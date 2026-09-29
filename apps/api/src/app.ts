import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config/index.js';
import { JsonLogger, type Logger } from './observability/logger.js';
import {
  getOrGenerateCorrelationId,
  generateRequestId,
  attachCorrelationHeaders,
} from './observability/correlation.js';
import { createErrorHandler } from './errors/handler.js';
import { createDatabaseService, type DatabaseService } from './infra/database/index.js';
import { createRedisService, type RedisService } from './infra/redis/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    requestId: string;
    logger: Logger;
  }
}

export interface AppDependencies {
  config: AppConfig;
  logger?: Logger;
  database?: DatabaseService;
  redis?: RedisService;
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config } = dependencies;

  const rootLogger =
    dependencies.logger ??
    new JsonLogger({
      serviceName: config.observability.serviceName,
      level: config.app.logLevel,
      pretty: config.observability.logPretty,
      redactKeys: config.observability.redactKeys,
    });

  const db = dependencies.database ?? createDatabaseService(config.postgres);
  const redis = dependencies.redis ?? createRedisService(config.redis);

  const app = Fastify({
    logger: false, // Structured logging handled explicitly via JsonLogger in request hooks
  });

  // Global Error Handler
  app.setErrorHandler(createErrorHandler(rootLogger));

  // Request Lifecycle: Correlation and Request ID handling
  app.addHook('onRequest', async (req, reply) => {
    const correlationId = getOrGenerateCorrelationId(req);
    const requestId = generateRequestId();

    req.correlationId = correlationId;
    req.requestId = requestId;
    req.logger = rootLogger.child({ correlationId, requestId });

    attachCorrelationHeaders(reply, correlationId, requestId);

    req.logger.info(`Inbound HTTP ${req.method} ${req.url}`, {
      method: req.method,
      url: req.url,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  });

  app.addHook('onResponse', async (req, reply) => {
    const elapsedMs = reply.elapsedTime;
    const reqLogger = req.logger ?? rootLogger;
    reqLogger.info(`Completed HTTP ${req.method} ${req.url} - ${reply.statusCode}`, {
      statusCode: reply.statusCode,
      elapsedMs,
    });
  });

  // Foundational Liveness Probe
  app.get('/live', async () => {
    return {
      status: 'ok',
      service: config.observability.serviceName,
      timestamp: new Date().toISOString(),
    };
  });

  // Health Probe with Component Statuses
  app.get('/health', async () => {
    const dbHealth = await db.checkHealth();
    const redisHealth = await redis.checkHealth();

    return {
      status: 'ok',
      service: config.observability.serviceName,
      timestamp: new Date().toISOString(),
      components: {
        database: dbHealth,
        redis: redisHealth,
      },
    };
  });

  return app;
}
