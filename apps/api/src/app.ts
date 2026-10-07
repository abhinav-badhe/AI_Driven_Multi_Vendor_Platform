import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
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
import { PostgresPoolConnection, type DatabaseConnection } from './infra/database/connection.js';
import { MigrationRunner } from './infra/database/migrations/runner.js';
import { seedDemoData } from './infra/database/seed.js';
import { identityModule } from './modules/identity/index.js';
import { merchantModule } from './modules/merchant/index.js';
import { catalogModule } from './modules/catalog/index.js';
import { marketplaceModule } from './modules/marketplace/index.js';
import { inventoryModule } from './modules/inventory/index.js';
import { cartCheckoutModule } from './modules/cart-checkout/index.js';
import { paymentModule } from './modules/payment/index.js';
import { ordersModule } from './modules/orders/index.js';
import { fulfillmentModule } from './modules/fulfillment/index.js';
import { settlementLedgerModule } from './modules/settlement-ledger/index.js';
import { searchModule, type ISearchStore, SqlSearchStore } from './modules/search/index.js';
import { eventsModule, type EventTransport } from './modules/events/index.js';
import { notificationModule, ResendEmailProvider } from './modules/notifications/index.js';
import { priceAlertsModule } from './modules/price-alerts/index.js';
import { analyticsModule } from './modules/analytics/index.js';
import { recommendationsModule } from './modules/recommendations/index.js';
import { analyticsMlModule } from './modules/analytics-ml/index.js';
import { SqlMlStore } from './infra/ml/sql-ml-store.js';
import { registerIdentityRoutes } from './http/identity-routes.js';
import { registerMerchantRoutes } from './http/merchant-routes.js';
import { registerCatalogRoutes } from './http/catalog-routes.js';
import { registerListingRoutes } from './http/listing-routes.js';
import { registerPriceAlertRoutes } from './http/price-alert-routes.js';
import { registerInventoryRoutes } from './http/inventory-routes.js';
import { registerCartRoutes } from './http/cart-routes.js';
import { registerCheckoutRoutes } from './http/checkout-routes.js';
import { registerPaymentRoutes } from './http/payment-routes.js';
import { registerOrderRoutes } from './http/order-routes.js';
import { registerFulfillmentRoutes } from './http/fulfillment-routes.js';
import { registerSettlementRoutes } from './http/settlement-routes.js';
import { registerSearchRoutes } from './http/search-routes.js';
import { registerEventAndNotificationRoutes } from './http/event-routes.js';
import { registerAnalyticsRoutes } from './http/analytics-routes.js';
import { registerRecommendationRoutes } from './http/recommendation-routes.js';
import { registerMlRoutes } from './http/ml-routes.js';
import { registerAiRoutes } from './http/ai-routes.js';
import {
  aiModule,
  InMemoryAiStore,
  InMemoryVectorStore,
  MockEmbeddingProvider,
  MockLLMProvider,
  MockWhatsAppProvider,
} from './modules/ai/index.js';
import { SqlAiStore } from './infra/ai/sql-ai-store.js';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

let __dirname = '';
try {
  if (typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')) {
    __dirname = fileURLToPath(new URL('.', import.meta.url));
  } else {
    const cwd = process.cwd();
    const root = cwd.includes('apps') ? resolve(cwd, '../..') : cwd;
    __dirname = join(root, 'apps/api/src');
  }
} catch {
  const cwd = process.cwd();
  const root = cwd.includes('apps') ? resolve(cwd, '../..') : cwd;
  __dirname = join(root, 'apps/api/src');
}

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    requestId: string;
    logger: Logger;
  }
}

export interface AppDependencies {
  config: AppConfig;
  logger?: Logger | undefined;
  database?: DatabaseService | undefined;
  redis?: RedisService | undefined;
  searchStore?: ISearchStore | undefined;
  eventTransport?: EventTransport | undefined;
  dbConnection?: DatabaseConnection | undefined;
  skipMigrations?: boolean | undefined;
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

  // Database connection (may be injected for testing)
  let dbConn: DatabaseConnection | null = dependencies.dbConnection ?? null;
  if (!dbConn && db.isConfigured && dependencies.skipMigrations !== true) {
    dbConn = new PostgresPoolConnection(config.postgres);
  }

  // Run migrations unless explicitly skipped (e.g. test environment with pre-seeded DB)
  if (dbConn && !dependencies.skipMigrations) {
    const migrationsDir = join(__dirname, 'infra', 'database', 'migrations');
    const runner = new MigrationRunner(migrationsDir);
    await runner.up(dbConn);
    await seedDemoData(dbConn, rootLogger);
  }

  const identityService =
    dbConn
      ? identityModule.createService(dbConn, rootLogger, config.identity.accessTokenSecret)
      : null;

  const merchantService = dbConn ? merchantModule.createService(dbConn, rootLogger) : null;
  const catalogService = dbConn ? catalogModule.createService(dbConn, rootLogger) : null;
  const marketplaceService =
    dbConn && catalogService && merchantService
      ? marketplaceModule.createService(dbConn, rootLogger, catalogService, merchantService)
      : null;
  const eventTransport = dependencies.eventTransport ?? eventsModule.createDefaultTransport();
  const outboxService = dbConn
    ? eventsModule.createOutboxService(dbConn, eventTransport, rootLogger)
    : null;

  const inventoryService =
    dbConn && marketplaceService
      ? inventoryModule.createService(dbConn, rootLogger, marketplaceService, outboxService ?? undefined)
      : null;
  const cartService =
    dbConn && marketplaceService
      ? cartCheckoutModule.createCartService(dbConn, rootLogger, marketplaceService)
      : null;
  const checkoutService =
    dbConn && marketplaceService && catalogService && inventoryService
      ? cartCheckoutModule.createCheckoutService(
          dbConn,
          rootLogger,
          marketplaceService,
          catalogService,
          inventoryService,
        )
      : null;

  const paymentService =
    dbConn && checkoutService && outboxService
      ? paymentModule.createService(dbConn, rootLogger, checkoutService, outboxService)
      : null;

  const orderService =
    dbConn && checkoutService && catalogService && inventoryService && paymentService
      ? ordersModule.createService(
          dbConn,
          rootLogger,
          checkoutService,
          catalogService,
          inventoryService,
          paymentService,
          outboxService ?? undefined,
        )
      : null;

  const fulfillmentService =
    dbConn && orderService && paymentService && inventoryService
      ? fulfillmentModule.createService(
          dbConn,
          rootLogger,
          orderService,
          paymentService,
          inventoryService,
        )
      : null;

  const settlementService =
    dbConn && orderService && paymentService
      ? settlementLedgerModule.createService(
          dbConn,
          rootLogger,
          orderService,
          paymentService,
        )
      : null;

  const searchStore =
    dependencies.searchStore ??
    (dbConn && config.search?.storeAdapter !== 'memory'
      ? new SqlSearchStore(dbConn)
      : searchModule.createDefaultStore());
  const searchService = searchModule.createService(
    searchStore,
    rootLogger,
    catalogService ?? undefined,
    marketplaceService ?? undefined,
    inventoryService ?? undefined,
    merchantService ?? undefined,
  );



  const notificationService = dbConn
    ? notificationModule.createService(
        dbConn,
        rootLogger,
        config.notifications.resendApiKey
          ? new ResendEmailProvider(
              config.notifications.resendApiKey,
              config.notifications.emailFrom,
            )
          : undefined,
      )
    : null;

  const priceAlertService =
    dbConn && notificationService
      ? priceAlertsModule.createService(
          dbConn,
          notificationService,
          rootLogger,
          config.notifications.frontendUrl,
        )
      : null;

  const analyticsService = dbConn
    ? analyticsModule.createService(dbConn, rootLogger)
    : null;

  const recommendationService =
    dbConn && catalogService && marketplaceService && analyticsService
      ? recommendationsModule.createService(
          dbConn,
          rootLogger,
          catalogService,
          marketplaceService,
          analyticsService,
        )
      : null;

  const mlStore = dbConn ? new SqlMlStore(dbConn) : analyticsMlModule.createDefaultStore();
  const mlService = analyticsService
    ? analyticsMlModule.createService(mlStore, analyticsService, rootLogger)
    : null;

  if (dbConn && outboxService && notificationService) {
    eventsModule.createSearchConsumer(dbConn, eventTransport, rootLogger, searchService);
    notificationModule.createConsumer(dbConn, eventTransport, rootLogger, notificationService);
    
    if (orderService) {
      ordersModule.createConsumer(dbConn, eventTransport, rootLogger, orderService);
    }
    if (analyticsService) {
      analyticsModule.createConsumer(dbConn, eventTransport, rootLogger, analyticsService);
    }
    if (recommendationService) {
      recommendationsModule.createConsumer(dbConn, eventTransport, rootLogger, recommendationService);
    }
  }

  const app = Fastify({
    logger: false, // Structured logging handled explicitly via JsonLogger in request hooks
  });

  // Security & HTTP Middleware
  app.register(fastifyCookie);
  
  // Configure CORS explicitly. In production, this should derive from config.
  app.register(fastifyCors, {
    origin: config.app.corsOrigins ?? ['http://localhost:3000'],
    credentials: true,
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
    const searchHealth = await searchStore.healthCheck();

    return {
      status: 'ok',
      service: config.observability.serviceName,
      timestamp: new Date().toISOString(),
      components: {
        database: dbHealth,
        redis: redisHealth,
        search: searchHealth,
        events: { status: 'ok', transport: 'in-memory' },
        analytics: { status: 'ok' },
        recommendations: { status: 'ok' },
      },
    };
  });

  // Register Identity, Merchant, Catalog, Marketplace, Inventory, Cart & Checkout, Payment, Orders, Search, Events & Notifications routes
  if (
    identityService &&
    merchantService &&
    catalogService &&
    marketplaceService &&
    inventoryService &&
    cartService &&
    checkoutService
  ) {
    registerIdentityRoutes(app, identityService, {
      verification: notificationService
        ? {
            frontendUrl: config.notifications.frontendUrl,
            sendEmail: (to, subject, body) =>
              notificationService.sendTransactionalEmail(to, subject, body),
          }
        : undefined,
    });    registerMerchantRoutes(app, identityService, merchantService);
    registerCatalogRoutes(app, identityService, catalogService);
    registerListingRoutes(app, identityService, marketplaceService, priceAlertService ?? undefined);
    if (priceAlertService) {
      registerPriceAlertRoutes(app, identityService, priceAlertService);
    }
    registerInventoryRoutes(app, identityService, inventoryService);
    registerCartRoutes(app, identityService, cartService);
    registerCheckoutRoutes(app, identityService, checkoutService);

    if (paymentService) {
      registerPaymentRoutes(app, identityService, paymentService);
    }
    if (orderService) {
      registerOrderRoutes(app, identityService, orderService);
    }
    if (fulfillmentService) {
      registerFulfillmentRoutes(app, identityService, fulfillmentService);
    }
    if (settlementService) {
      registerSettlementRoutes(app, identityService, settlementService);
    }
    registerSearchRoutes(app, identityService, searchService);

    if (outboxService && notificationService) {
      registerEventAndNotificationRoutes(app, identityService, outboxService, notificationService);
    }

    if (analyticsService) {
      registerAnalyticsRoutes(app, identityService, analyticsService);
    }

    if (recommendationService) {
      registerRecommendationRoutes(app, identityService, recommendationService);
    }

    if (mlService) {
      registerMlRoutes(app, identityService, mlService);
      mlService.startRetrainingScheduler(60000);
      app.addHook('onClose', async () => {
        mlService.stopRetrainingScheduler();
      });
    }

    if (inventoryService) {
      inventoryService.startExpirationWorker(60000);
      app.addHook('onClose', async () => {
        inventoryService.stopExpirationWorker();
      });
    }

    // Outbox relay: publish pending domain events to the transport every 10s
    // so derived projections (search, analytics, recommendations) stay fresh
    // without manual admin triggers. Email dispatch stays explicit via the
    // notification processing endpoint. Disabled under NODE_ENV=test so
    // suites keep deterministic control via POST /events/outbox/process.
    if (outboxService && config.app.nodeEnv !== 'test') {
      let relayRunning = false;
      const outboxRelay = setInterval(() => {
        if (relayRunning) return;
        relayRunning = true;
        outboxService
          .publishPendingEvents({ batchSize: 100 })
          .catch((err: unknown) => {
            rootLogger.warn('Outbox relay publish failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            relayRunning = false;
          });
      }, 10000);
      app.addHook('onClose', async () => {
        clearInterval(outboxRelay);
      });
    }

    // Notification processor: dispatch pending emails/sms/push every 30s
    // so price-drop alerts and other marketing notifications are delivered
    // without requiring manual admin triggers.
    if (notificationService && config.app.nodeEnv !== 'test') {
      let processorRunning = false;
      const notificationProcessor = setInterval(() => {
        if (processorRunning) return;
        processorRunning = true;
        notificationService
          .processPendingNotifications({ batchSize: 50 })
          .catch((err: unknown) => {
            rootLogger.warn('Notification processor failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            processorRunning = false;
          });
      }, 30000);
      app.addHook('onClose', async () => {
        clearInterval(notificationProcessor);
      });
    }

    // Phase 14 AI Module initialization
    const aiStore = dbConn ? new SqlAiStore(dbConn) : new InMemoryAiStore();
    const vectorStore = new InMemoryVectorStore();
    const embeddingProvider = new MockEmbeddingProvider();
    const llmProvider = new MockLLMProvider();
    const whatsAppProvider = new MockWhatsAppProvider();

    const toolRegistry = aiModule.createToolRegistry({
      orderService: orderService ?? undefined,
      catalogService,
      listingService: marketplaceService,
      inventoryService,
      recommendationsService: recommendationService ?? undefined,
      mlSignalReader: mlService ?? undefined,
      fulfillmentService: fulfillmentService ?? undefined,
      paymentService: paymentService ?? undefined,
      searchService,
    });

    const ragService = aiModule.createRagService(
      aiStore,
      vectorStore,
      embeddingProvider,
      rootLogger,
    );

    const orchestrator = aiModule.createOrchestrator(
      aiStore,
      toolRegistry,
      ragService,
      llmProvider,
      rootLogger,
    );

    const whatsAppAdapter = aiModule.createWhatsAppAdapter(
      aiStore,
      orchestrator,
      whatsAppProvider,
      rootLogger,
    );

    registerAiRoutes(app, identityService, {
      orchestrator,
      ragService,
      whatsAppAdapter,
      store: aiStore,
      whatsAppWebhookSecret: 'commerce-whatsapp-webhook-secret',
    });
  }

  return app;
}
