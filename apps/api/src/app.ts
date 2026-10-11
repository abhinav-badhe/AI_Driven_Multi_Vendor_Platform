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
import { CacheService } from './infra/redis/cache.js';
import { CompositeRateLimiter } from './http/rate-limiter.js';
import { PostgresPoolConnection, type DatabaseConnection } from './infra/database/connection.js';
import { MigrationRunner } from './infra/database/migrations/runner.js';
import { seedDemoData } from './infra/database/seed.js';
import {
  identityModule,
  type IIdentityActorResolver,
  type ISecurityAuditService,
} from './modules/identity/index.js';
import { merchantModule, type IMerchantService } from './modules/merchant/index.js';
import { catalogModule, type ICatalogService } from './modules/catalog/index.js';
import { marketplaceModule, type IMarketplaceService } from './modules/marketplace/index.js';
import { inventoryModule, type IInventoryService } from './modules/inventory/index.js';
import { cartCheckoutModule, type ICartService, type ICheckoutService } from './modules/cart-checkout/index.js';
import { paymentModule, StripePaymentProvider, RazorpayPaymentProvider, MockPaymentProvider, type PaymentProvider, type IPaymentService } from './modules/payment/index.js';
import { ordersModule, type IOrderService } from './modules/orders/index.js';
import {
  fulfillmentModule,
  ShippoCarrierProvider,
  MockCarrierProvider,
  type CarrierProvider,
  type IFulfillmentService,
} from './modules/fulfillment/index.js';
import {
  settlementLedgerModule,
  type ISettlementService,
} from './modules/settlement-ledger/index.js';
import { searchModule, type ISearchStore, SqlSearchStore } from './modules/search/index.js';
import { eventsModule, type EventTransport, type ConsumerRetryRunner, type IOutboxService } from './modules/events/index.js';
import {
  notificationModule,
  ResendEmailProvider,
  type INotificationClient,
  type HttpEventForwarder,
} from './modules/notifications/index.js';
import { priceAlertsModule, type PriceAlertSweepRunner } from './modules/price-alerts/index.js';
import {
  analyticsModule,
  type IAnalyticsRecommendationReader,
  type IAnalyticsMlFeatureReader,
} from './modules/analytics/index.js';
import {
  recommendationsModule,
  SqlRecommendationStore,
  type IRecommendationStore,
} from './modules/recommendations/index.js';
import { analyticsMlModule, type IMlExecutionProvider } from './modules/analytics-ml/index.js';
import { promotionPricingModule, type IPromotionPricingEngine } from './modules/promotion-pricing/index.js';
import { SqlMlStore } from './infra/ml/sql-ml-store.js';
import { registerIdentityRoutes } from './http/identity-routes.js';
import { registerMerchantRoutes } from './http/merchant-routes.js';
import { registerCatalogRoutes } from './http/catalog-routes.js';
import { registerListingRoutes } from './http/listing-routes.js';
import { registerPromotionRoutes } from './http/promotion-routes.js';
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
import { customerModule, type ICustomerAddressReader } from './modules/customer/index.js';
import { registerCustomerAddressRoutes } from './http/customer-address-routes.js';
import { createReviewService } from './modules/catalog/index.js';
import { registerReviewRoutes } from './http/review-routes.js';
import { registerWishlistRoutes } from './http/wishlist-routes.js';
import { registerBackInStockRoutes } from './http/back-in-stock-routes.js';
import {
  aiModule,
  InMemoryAiStore,
  InMemoryVectorStore,
  MockEmbeddingProvider,
  MockLLMProvider,
  MockWhatsAppProvider,
  MetaWhatsAppCloudProvider,
  type IAiService,
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
  interface FastifyInstance {
    cache: CacheService;
    actorResolver?: IIdentityActorResolver | null;
    securityAuditService?: ISecurityAuditService | null;
    eventForwarder?: HttpEventForwarder | null;
    consumerRetryRunner?: ConsumerRetryRunner | null;
    priceAlertSweepRunner?: PriceAlertSweepRunner | null;
  }
}

export interface AppDependencies {
  config: AppConfig;
  logger?: Logger | undefined;
  database?: DatabaseService | undefined;
  redis?: RedisService | undefined;
  cache?: CacheService | undefined;
  searchStore?: ISearchStore | undefined;
  eventTransport?: EventTransport | undefined;
  paymentProvider?: PaymentProvider | undefined;
  carrierProvider?: CarrierProvider | undefined;
  dbConnection?: DatabaseConnection | undefined;
  skipMigrations?: boolean | undefined;
  notificationFetchFn?: typeof fetch | undefined;
  mlFetchFn?: typeof fetch | undefined;
  searchFetchFn?: typeof fetch | undefined;
  recommendationFetchFn?: typeof fetch | undefined;
  recommendationStore?: IRecommendationStore | undefined;
  analyticsFetchFn?: typeof fetch | undefined;
  analyticsReader?: (IAnalyticsRecommendationReader & IAnalyticsMlFeatureReader) | undefined;
  mlExecutionProvider?: IMlExecutionProvider | undefined;
  actorResolver?: IIdentityActorResolver | undefined;
  securityAuditService?: ISecurityAuditService | undefined;
  enableBackgroundWorkers?: boolean | undefined;
  consumerRetryRunner?: ConsumerRetryRunner | undefined;
  priceAlertSweepRunner?: PriceAlertSweepRunner | undefined;
  customerFetchFn?: typeof fetch | undefined;
  customerAddressReader?: ICustomerAddressReader | undefined;
  promotionFetchFn?: typeof fetch | undefined;
  promotionPricingEngine?: IPromotionPricingEngine | undefined;
  merchantFetchFn?: typeof fetch | undefined;
  merchantService?: IMerchantService | undefined;
  catalogFetchFn?: typeof fetch | undefined;
  catalogService?: ICatalogService | undefined;
  marketplaceFetchFn?: typeof fetch | undefined;
  marketplaceService?: IMarketplaceService | undefined;
  inventoryFetchFn?: typeof fetch | undefined;
  inventoryService?: IInventoryService | undefined;
  cartFetchFn?: typeof fetch | undefined;
  cartService?: ICartService | undefined;
  checkoutFetchFn?: typeof fetch | undefined;
  checkoutService?: ICheckoutService | undefined;
  orderFetchFn?: typeof fetch | undefined;
  orderService?: IOrderService | undefined;
  paymentFetchFn?: typeof fetch | undefined;
  paymentService?: IPaymentService | undefined;
  fulfillmentFetchFn?: typeof fetch | undefined;
  fulfillmentService?: IFulfillmentService | undefined;
  settlementFetchFn?: typeof fetch | undefined;
  settlementService?: ISettlementService | undefined;
  eventBrokerFetchFn?: typeof fetch | undefined;
  outboxService?: IOutboxService | undefined;
  aiFetchFn?: typeof fetch | undefined;
  aiService?: IAiService | undefined;
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
  const redis = dependencies.redis ?? createRedisService(config.redis, rootLogger);
  const cacheService = dependencies.cache ?? new CacheService(redis);

  // Global API guardrail: generous per-route limit that only bites during
  // abuse bursts. Disabled under NODE_ENV=test so suites keep deterministic
  // control over request volume (mirrors the outbox relay below).
  const globalRateLimiter =
    config.app.nodeEnv !== 'test'
      ? new CompositeRateLimiter(redis, { windowMs: 60_000, maxRequests: 600 }, undefined, 'rl:global')
      : null;

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

  const securityAuditService =
    dependencies.securityAuditService ??
    (dbConn ? identityModule.createAuditService(dbConn, rootLogger) : identityModule.createInMemoryAuditService());

  const identityService =
    dbConn
      ? identityModule.createService(dbConn, rootLogger, config.identity.accessTokenSecret, securityAuditService)
      : null;

  const actorResolver: IIdentityActorResolver | null =
    dependencies.actorResolver ??
    (config.identity.verificationMode === 'gateway'
      ? identityModule.createGatewayResolver(
          identityService ?? identityModule.createStatelessResolver(config.identity.accessTokenSecret),
        )
      : config.identity.verificationMode === 'stateless'
        ? identityModule.createStatelessResolver(config.identity.accessTokenSecret)
        : identityService);

  const localMerchantService = dbConn ? merchantModule.createService(dbConn, rootLogger, securityAuditService) : null;

  // Merchant service: injected override > http client > local DB service
  const merchantService: IMerchantService | null =
    dependencies.merchantService ??
    (config.merchant?.mode === 'http' && config.merchant?.serviceUrl
      ? merchantModule.createHttpClient(config.merchant.serviceUrl, {
          timeoutMs: config.merchant.timeoutMs,
          fetchFn: dependencies.merchantFetchFn,
          fallbackService: localMerchantService ?? undefined,
          logger: rootLogger,
        })
      : localMerchantService);

  const localCatalogService = dbConn ? catalogModule.createService(dbConn, rootLogger) : null;

  // Catalog service: injected override > http client > local DB service
  const catalogService: ICatalogService | null =
    dependencies.catalogService ??
    (config.catalog?.mode === 'http' && config.catalog?.serviceUrl
      ? catalogModule.createHttpClient(config.catalog.serviceUrl, {
          timeoutMs: config.catalog.timeoutMs,
          fetchFn: dependencies.catalogFetchFn,
          fallbackService: localCatalogService ?? undefined,
          logger: rootLogger,
        })
      : localCatalogService);
  const localMarketplaceService =
    dbConn && catalogService && merchantService
      ? marketplaceModule.createService(dbConn, rootLogger, catalogService, merchantService, securityAuditService)
      : null;

  // Marketplace service: injected override > http client > local DB service
  const marketplaceService: IMarketplaceService | null =
    dependencies.marketplaceService ??
    (config.marketplace?.mode === 'http' && config.marketplace?.serviceUrl
      ? marketplaceModule.createHttpClient(config.marketplace.serviceUrl, {
          timeoutMs: config.marketplace.timeoutMs,
          fetchFn: dependencies.marketplaceFetchFn,
          fallbackService: localMarketplaceService ?? undefined,
          logger: rootLogger,
        })
      : localMarketplaceService);
  const localEventTransport = dependencies.eventTransport ?? eventsModule.createDefaultTransport();
  const eventTransport =
    dependencies.eventTransport ??
    (config.eventBroker?.mode === 'http' && config.eventBroker?.serviceUrl
      ? eventsModule.createHttpTransport(config.eventBroker.serviceUrl, {
          timeoutMs: config.eventBroker.timeoutMs,
          fetchFn: dependencies.eventBrokerFetchFn,
          fallbackTransport: localEventTransport,
          logger: rootLogger,
        })
      : localEventTransport);

  const localOutboxService = dbConn
    ? eventsModule.createOutboxService(dbConn, eventTransport, rootLogger)
    : null;

  const outboxService: IOutboxService | null =
    dependencies.outboxService ??
    (config.eventBroker?.mode === 'http' && config.eventBroker?.serviceUrl
      ? eventsModule.createHttpOutboxClient(config.eventBroker.serviceUrl, {
          timeoutMs: config.eventBroker.timeoutMs,
          fetchFn: dependencies.eventBrokerFetchFn,
          fallbackService: localOutboxService ?? undefined,
          logger: rootLogger,
        })
      : localOutboxService);

  const consumerRetryRunner =
    dependencies.consumerRetryRunner ??
    (dbConn ? eventsModule.createConsumerRetryRunner(rootLogger) : null);

  const localInventoryService =
    dbConn && marketplaceService
      ? inventoryModule.createService(
          dbConn,
          rootLogger,
          marketplaceService,
          localOutboxService ?? undefined,
          cacheService,
        )
      : null;

  // Inventory service: injected override > http client > local DB service
  const inventoryService: IInventoryService | null =
    dependencies.inventoryService ??
    (config.inventory?.mode === 'http' && config.inventory?.serviceUrl
      ? inventoryModule.createHttpClient(config.inventory.serviceUrl, {
          timeoutMs: config.inventory.timeoutMs,
          fetchFn: dependencies.inventoryFetchFn,
          fallbackService: localInventoryService ?? undefined,
          logger: rootLogger,
        })
      : localInventoryService);
  const localCartService =
    dbConn && marketplaceService
      ? cartCheckoutModule.createCartService(dbConn, rootLogger, marketplaceService)
      : null;

  // Cart service: injected override > http client > local DB service
  const cartService: ICartService | null =
    dependencies.cartService ??
    (config.cart?.mode === 'http' && config.cart?.serviceUrl
      ? cartCheckoutModule.createHttpCartClient(config.cart.serviceUrl, {
          timeoutMs: config.cart.timeoutMs,
          fetchFn: dependencies.cartFetchFn,
          fallbackService: localCartService ?? undefined,
          logger: rootLogger,
        })
      : localCartService);

  // Customer address reader: injected override > http client > local DB service
  const customerAddressReader: ICustomerAddressReader | null =
    dependencies.customerAddressReader ??
    (config.customer.mode === 'http' && config.customer.serviceUrl
      ? customerModule.createHttpAddressClient(config.customer.serviceUrl, {
          timeoutMs: config.customer.timeoutMs,
          fetchFn: dependencies.customerFetchFn,
        })
      : dbConn
        ? customerModule.createAddressService(dbConn, rootLogger)
        : null);

  // Keep the concrete service for routes that need full CRUD (only in local mode)
  const customerAddressService =
    config.customer.mode === 'local' && dbConn
      ? customerModule.createAddressService(dbConn, rootLogger)
      : null;


  const wishlistService =
    dbConn && cartService
      ? customerModule.createWishlistService(dbConn, rootLogger, cartService, localOutboxService ?? undefined)
      : null;
  const reviewService = dbConn
    ? createReviewService(dbConn, rootLogger, localOutboxService ?? undefined)
    : null;

  const localCheckoutService =
    dbConn && marketplaceService && catalogService && inventoryService
      ? cartCheckoutModule.createCheckoutService(
          dbConn,
          rootLogger,
          marketplaceService,
          catalogService,
          inventoryService,
          customerAddressReader ?? undefined,
        )
      : null;

  // Checkout service: injected override > http client > local DB service
  const checkoutService: ICheckoutService | null =
    dependencies.checkoutService ??
    (config.checkout?.mode === 'http' && config.checkout?.serviceUrl
      ? cartCheckoutModule.createHttpCheckoutClient(config.checkout.serviceUrl, {
          timeoutMs: config.checkout.timeoutMs,
          fetchFn: dependencies.checkoutFetchFn,
          fallbackService: localCheckoutService ?? undefined,
          logger: rootLogger,
        })
      : localCheckoutService);

  const paymentProvider =
    dependencies.paymentProvider ??
    (config.payment?.provider === 'razorpay'
      ? new RazorpayPaymentProvider(
          {
            keyId: config.payment.razorpayKeyId || 'rzp_test_mockKey123',
            keySecret: config.payment.razorpayKeySecret || 'rzp_test_mockSecret456',
            webhookSecret: config.payment.razorpayWebhookSecret,
          },
          rootLogger,
        )
      : config.payment?.provider === 'stripe' && config.payment?.secretKey
      ? new StripePaymentProvider(
          {
            secretKey: config.payment.secretKey,
            webhookSecret: config.payment.webhookSecret,
            publishableKey: config.payment.publishableKey,
            apiVersion: config.payment.apiVersion,
            webhookToleranceSeconds: config.payment.webhookToleranceSeconds,
          },
          rootLogger,
        )
      : new MockPaymentProvider());

  const localPaymentService =
    dbConn && checkoutService && localOutboxService
      ? paymentModule.createService(
          dbConn,
          rootLogger,
          checkoutService,
          localOutboxService,
          paymentProvider,
          config.payment?.webhookSecret,
          config.payment?.webhookToleranceSeconds,
        )
      : null;

  const paymentService: IPaymentService | null =
    dependencies.paymentService ??
    (config.payment?.mode === 'http' && config.payment?.serviceUrl
      ? paymentModule.createHttpClient(config.payment.serviceUrl, {
          timeoutMs: config.payment.timeoutMs,
          fetchFn: dependencies.paymentFetchFn,
          fallbackService: localPaymentService ?? undefined,
          logger: rootLogger,
        })
      : localPaymentService);

  const promotionService = dbConn
    ? promotionPricingModule.createService(dbConn, rootLogger, localOutboxService ?? undefined, securityAuditService)
    : null;

  // Promotion Pricing Engine: injected override > http client > local DB service
  const promotionPricingEngine: IPromotionPricingEngine | null =
    dependencies.promotionPricingEngine ??
    (config.promotion?.mode === 'http' && config.promotion?.serviceUrl
      ? promotionPricingModule.createHttpClient({
          baseUrl: config.promotion.serviceUrl,
          timeoutMs: config.promotion.timeoutMs,
          fetchFn: dependencies.promotionFetchFn,
          fallbackEngine: promotionService ?? undefined,
        })
      : promotionService);

  const localOrderService =
    dbConn && checkoutService && catalogService && inventoryService && paymentService
      ? ordersModule.createService(
          dbConn,
          rootLogger,
          checkoutService,
          catalogService,
          inventoryService,
          paymentService,
          localOutboxService ?? undefined,
          promotionService ?? undefined,
        )
      : null;

  const orderService: IOrderService | null =
    dependencies.orderService ??
    (config.orders?.mode === 'http' && config.orders?.serviceUrl
      ? ordersModule.createHttpOrderClient(config.orders.serviceUrl, {
          timeoutMs: config.orders.timeoutMs,
          fetchFn: dependencies.orderFetchFn,
          fallbackService: localOrderService ?? undefined,
          logger: rootLogger,
        })
      : localOrderService);

  const carrierProvider =
    dependencies.carrierProvider ??
    (config.shipping?.provider === 'shippo' && config.shipping?.apiKey
      ? new ShippoCarrierProvider(
          {
            apiKey: config.shipping.apiKey,
            baseUrl: config.shipping.baseUrl,
            webhookSecret: config.shipping.webhookSecret,
            timeoutMs: config.shipping.timeoutMs,
            webhookToleranceSeconds: config.shipping.webhookToleranceSeconds,
          },
          rootLogger,
        )
      : new MockCarrierProvider());

  const localFulfillmentService =
    dbConn && orderService && paymentService && inventoryService
      ? fulfillmentModule.createService(
          dbConn,
          rootLogger,
          orderService,
          paymentService,
          inventoryService,
          carrierProvider,
          config.shipping?.webhookSecret,
          localOutboxService ?? undefined,
          config.shipping?.webhookToleranceSeconds,
        )
      : null;

  const fulfillmentService: IFulfillmentService | null =
    dependencies.fulfillmentService ??
    (config.fulfillment?.mode === 'http' && config.fulfillment?.serviceUrl
      ? fulfillmentModule.createHttpClient(config.fulfillment.serviceUrl, {
          timeoutMs: config.fulfillment.timeoutMs,
          fetchFn: dependencies.fulfillmentFetchFn,
          fallbackService: localFulfillmentService ?? undefined,
          logger: rootLogger,
        })
      : localFulfillmentService);

  const localSettlementService =
    dbConn && orderService && paymentService
      ? settlementLedgerModule.createService(
          dbConn,
          rootLogger,
          orderService,
          paymentService,
        )
      : null;

  const settlementService: ISettlementService | null =
    dependencies.settlementService ??
    (config.settlement?.mode === 'http' && config.settlement?.serviceUrl
      ? settlementLedgerModule.createHttpClient(config.settlement.serviceUrl, {
          timeoutMs: config.settlement.timeoutMs,
          fetchFn: dependencies.settlementFetchFn,
          fallbackService: localSettlementService ?? undefined,
        })
      : localSettlementService);

  const searchStore =
    dependencies.searchStore ??
    (config.search?.storeAdapter === 'http' && config.search?.serviceUrl
      ? searchModule.createHttpStore(config.search.serviceUrl, {
          timeoutMs: config.search.timeoutMs,
          fetchFn: dependencies.searchFetchFn,
          fallbackStore:
            dbConn
              ? new SqlSearchStore(dbConn)
              : searchModule.createDefaultStore(),
          logger: rootLogger,
        })
      : dbConn && config.search?.storeAdapter !== 'memory'
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

  const notificationClient: INotificationClient | null =
    config.notifications.clientMode === 'http' &&
    config.notifications.serviceUrl &&
    config.notifications.serviceKey
      ? notificationModule.createHttpClient({
          baseUrl: config.notifications.serviceUrl,
          internalServiceKey: config.notifications.serviceKey,
          timeoutMs: config.notifications.timeoutMs,
          fetchFn: dependencies.notificationFetchFn,
        })
      : notificationService
        ? notificationModule.createClient(notificationService)
        : null;

  let eventForwarder: HttpEventForwarder | null = null;

  const priceAlertService =
    dbConn && notificationClient
      ? priceAlertsModule.createService(
          dbConn,
          notificationClient,
          rootLogger,
          config.notifications.frontendUrl,
        )
      : null;

  const priceAlertSweepRunner =
    dependencies.priceAlertSweepRunner ??
    (priceAlertService
      ? priceAlertsModule.createSweepRunner(priceAlertService, rootLogger, {
          intervalMs: 60000,
          sinceDays: 90,
        })
      : null);

  const backInStockService = dbConn
    ? customerModule.createBackInStockService(
        dbConn,
        rootLogger,
        notificationClient ?? undefined,
        localOutboxService ?? undefined,
        config.notifications?.frontendUrl,
      )
    : null;

  const localAnalyticsService = dbConn
    ? analyticsModule.createService(dbConn, rootLogger)
    : null;

  const analyticsReader: IAnalyticsRecommendationReader & IAnalyticsMlFeatureReader =
    dependencies.analyticsReader ??
    (config.analytics?.mode === 'http' && config.analytics?.serviceUrl
      ? analyticsModule.createHttpClient(config.analytics.serviceUrl, {
          timeoutMs: config.analytics.timeoutMs,
          fetchFn: dependencies.analyticsFetchFn,
          fallbackReader: localAnalyticsService ?? analyticsModule.createInMemoryReader(),
          logger: rootLogger,
        })
      : (localAnalyticsService ?? analyticsModule.createInMemoryReader()));

  const analyticsService = localAnalyticsService;

  const recommendationStore =
    dependencies.recommendationStore ??
    (config.recommendations?.storeAdapter === 'http' && config.recommendations?.serviceUrl
      ? recommendationsModule.createHttpStore(config.recommendations.serviceUrl, {
          timeoutMs: config.recommendations.timeoutMs,
          fetchFn: dependencies.recommendationFetchFn,
          fallbackStore:
            dbConn
              ? new SqlRecommendationStore(dbConn)
              : recommendationsModule.createInMemoryStore(),
          logger: rootLogger,
        })
      : dbConn && config.recommendations?.storeAdapter !== 'memory'
        ? new SqlRecommendationStore(dbConn)
        : recommendationsModule.createInMemoryStore());

  const recommendationService =
    catalogService && marketplaceService && analyticsReader
      ? recommendationsModule.createService(
          dbConn ?? undefined,
          rootLogger,
          catalogService,
          marketplaceService,
          analyticsReader,
          recommendationStore,
        )
      : null;

  const mlStore = dbConn ? new SqlMlStore(dbConn) : analyticsMlModule.createDefaultStore();
  const mlExecutionProvider =
    dependencies.mlExecutionProvider ??
    (config.ml?.executionMode === 'http' && config.ml?.serviceUrl
      ? analyticsMlModule.createCompositeExecutionProvider(
          analyticsMlModule.createHttpExecutionProvider(
            config.ml.serviceUrl,
            dependencies.mlFetchFn
              ? { timeoutMs: config.ml.timeoutMs, fetchFn: dependencies.mlFetchFn }
              : { timeoutMs: config.ml.timeoutMs },
          ),
          analyticsMlModule.createLocalExecutionProvider(rootLogger),
        )
      : undefined);
  const mlService = analyticsService
    ? analyticsMlModule.createService(mlStore, analyticsService, rootLogger, mlExecutionProvider)
    : null;

  if (dbConn && outboxService && (notificationClient || notificationService)) {
    const searchConsumer = eventsModule.createSearchConsumer(dbConn, eventTransport, rootLogger, searchService);
    consumerRetryRunner?.registerConsumer(searchConsumer);

    if (config.notifications.clientMode === 'http') {
      if (config.notifications.serviceUrl && config.notifications.serviceKey) {
        eventForwarder = notificationModule.createEventForwarder(
          eventTransport,
          rootLogger,
          {
            baseUrl: config.notifications.serviceUrl,
            internalServiceKey: config.notifications.serviceKey,
            timeoutMs: config.notifications.timeoutMs,
            fetchFn: dependencies.notificationFetchFn,
            db: dbConn ?? undefined,
          },
        );
      }
    } else {
      const consumerClient =
        notificationClient ??
        (notificationService ? notificationModule.createClient(notificationService) : null);
      if (consumerClient) {
        const notifConsumer = notificationModule.createConsumer(dbConn, eventTransport, rootLogger, consumerClient);
        consumerRetryRunner?.registerConsumer(notifConsumer);
      }
    }
    
    if (backInStockService) {
      const bisConsumer = customerModule.createBackInStockConsumer(dbConn, eventTransport, rootLogger, backInStockService);
      consumerRetryRunner?.registerConsumer(bisConsumer);
    }

    if (orderService) {
      const orderConsumer = ordersModule.createConsumer(dbConn, eventTransport, rootLogger, orderService);
      consumerRetryRunner?.registerConsumer(orderConsumer);
    }
    if (analyticsService) {
      const analyticsConsumer = analyticsModule.createConsumer(dbConn, eventTransport, rootLogger, analyticsService);
      consumerRetryRunner?.registerConsumer(analyticsConsumer);
    }
    if (recommendationService) {
      const recConsumer = recommendationsModule.createConsumer(dbConn, eventTransport, rootLogger, recommendationService);
      consumerRetryRunner?.registerConsumer(recConsumer);
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

  // Shared cache-aside service for route handlers (fail-open by design).
  app.decorate('cache', cacheService);
  if (eventForwarder) {
    app.decorate('eventForwarder', eventForwarder);
  }
  if (consumerRetryRunner) {
    app.decorate('consumerRetryRunner', consumerRetryRunner);
  }
  if (paymentService) {
    app.decorate('paymentService', paymentService);
  }
  if (actorResolver) {
    app.decorate('actorResolver', actorResolver);
  }
  if (securityAuditService) {
    app.decorate('securityAuditService', securityAuditService);
  }

  // Release the Redis connection on shutdown so test runners and
  // production deploys never hang on an open handle.
  app.addHook('onClose', async () => {
    await redis.shutdown();
  });

  if (globalRateLimiter) {
    const globalRateLimitHook = globalRateLimiter.middleware();
    app.addHook('preHandler', globalRateLimitHook);
  }

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
      // Distributed enforcement across instances with in-memory
      // fallback — identical to the previous limiter when Redis is down.
      rateLimiter: new CompositeRateLimiter(redis),
      verification: notificationClient
        ? {
            frontendUrl: config.notifications.frontendUrl,
            sendEmail: (to, subject, body) =>
              notificationClient.sendTransactionalEmail(to, subject, body),
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
    if (customerAddressService) {
      registerCustomerAddressRoutes(app, identityService, customerAddressService);
    }
    if (reviewService) {
      registerReviewRoutes(app, identityService, reviewService);
    }
    if (wishlistService) {
      registerWishlistRoutes(app, identityService, wishlistService);
    }
    if (backInStockService) {
      registerBackInStockRoutes(app, identityService, backInStockService);
    }

    if (promotionPricingEngine) {
      registerPromotionRoutes(app, identityService, promotionPricingEngine, analyticsService);
    }

    if (paymentService) {
      registerPaymentRoutes(app, identityService, paymentService, config);
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

    if (outboxService && (notificationService || notificationClient)) {
      registerEventAndNotificationRoutes(
        app,
        identityService,
        outboxService,
        notificationService,
        notificationClient,
        config.notifications.clientMode,
      );
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

    if (inventoryService?.startExpirationWorker) {
      inventoryService.startExpirationWorker(60000);
      app.addHook('onClose', async () => {
        inventoryService.stopExpirationWorker?.();
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
    if (notificationClient && config.app.nodeEnv !== 'test') {
      let processorRunning = false;
      const notificationProcessor = setInterval(() => {
        if (processorRunning) return;
        processorRunning = true;
        notificationClient
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

    // Forwarder retry runner: retries failed notification event forwarding every 15s
    // when HTTP mode is active. Uses atomic CAS claims in the database so multiple
    // API replicas never process the same receipt concurrently.
    // In-process overlap guard prevents piling up timers if a batch takes longer than 15s.
    // Cleaned up via onClose hook on application shutdown.
    // Disabled under NODE_ENV=test unless enableBackgroundWorkers is explicitly enabled.
    if (
      eventForwarder &&
      (config.app.nodeEnv !== 'test' || dependencies.enableBackgroundWorkers)
    ) {
      const forwarderInstance = eventForwarder;
      let forwarderRetryRunning = false;
      const forwarderRetryInterval = setInterval(() => {
        if (forwarderRetryRunning) return;
        forwarderRetryRunning = true;
        forwarderInstance
          .retryFailedEvents({
            batchSize: 50,
            baseRetryDelayMs: 2000,
            maxAttempts: 5,
            staleTimeoutMs: 300000,
          })
          .then(
            (res: {
              claimed: number;
              retried: number;
              succeeded: number;
              failed: number;
              quarantined: number;
            }) => {
              if (res.claimed > 0) {
                rootLogger.info('Notification event forwarding retry cycle completed', {
                  claimed: res.claimed,
                  succeeded: res.succeeded,
                  failed: res.failed,
                  quarantined: res.quarantined,
                });
              }
            },
          )
          .catch((err: unknown) => {
            rootLogger.warn('Notification event forwarding retry runner failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            forwarderRetryRunning = false;
          });
      }, 15000);

      app.addHook('onClose', async () => {
        clearInterval(forwarderRetryInterval);
      });
    }

    // Consumer retry runner: retries failed/stale consumer receipts every 15s.
    // Uses atomic CAS claims in the database so multiple API replicas never process the same receipt concurrently.
    // In-process overlap guard prevents piling up timers if a cycle takes longer than 15s.
    // Cleaned up via onClose hook on application shutdown.
    // Disabled under NODE_ENV=test unless enableBackgroundWorkers is explicitly enabled.
    if (
      consumerRetryRunner &&
      (config.app.nodeEnv !== 'test' || dependencies.enableBackgroundWorkers)
    ) {
      consumerRetryRunner.start();
    }

    if (consumerRetryRunner) {
      app.addHook('onClose', async () => {
        consumerRetryRunner.stop();
      });
    }

    // Price alert sweep runner: periodically sweeps recently watched products
    // to catch any price drops that were missed or failed during inline listing updates,
    // and reconciles delivery status for watchers whose notifications have been sent.
    // In-process overlap guard prevents piling up timers if a cycle takes longer than 60s.
    // Cleaned up via onClose hook on application shutdown.
    // Disabled under NODE_ENV=test unless enableBackgroundWorkers is explicitly enabled.
    if (
      priceAlertSweepRunner &&
      (config.app.nodeEnv !== 'test' || dependencies.enableBackgroundWorkers)
    ) {
      priceAlertSweepRunner.start();
    }

    if (priceAlertSweepRunner) {
      app.addHook('onClose', async () => {
        priceAlertSweepRunner.stop();
      });
      app.decorate('priceAlertSweepRunner', priceAlertSweepRunner);
    }

    // Phase 14 AI Module initialization
    const aiStore = dbConn ? new SqlAiStore(dbConn) : new InMemoryAiStore();
    const vectorStore = new InMemoryVectorStore();
    const embeddingProvider = new MockEmbeddingProvider();
    const llmProvider = new MockLLMProvider();
    const whatsAppProvider =
      config.whatsapp.provider === 'meta' &&
      config.whatsapp.accessToken &&
      config.whatsapp.phoneNumberId &&
      config.whatsapp.appSecret
        ? new MetaWhatsAppCloudProvider(
            {
              accessToken: config.whatsapp.accessToken,
              phoneNumberId: config.whatsapp.phoneNumberId,
              appSecret: config.whatsapp.appSecret,
              apiVersion: config.whatsapp.apiVersion,
            },
            rootLogger,
          )
        : new MockWhatsAppProvider();

    const toolRegistry = aiModule.createToolRegistry({
      orderService: orderService ?? undefined,
      catalogService: catalogService ?? undefined,
      listingService: marketplaceService,
      inventoryService,
      recommendationsService: recommendationService ?? undefined,
      mlSignalReader: mlService ?? undefined,
      fulfillmentService: fulfillmentService ?? undefined,
      paymentService: paymentService ?? undefined,
      searchService,
      cartService: cartService ?? undefined,
      checkoutService: checkoutService ?? undefined,
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

    const localAiService = aiModule.createLocalService(
      orchestrator,
      ragService,
      aiStore,
    );

    const aiService: IAiService | null =
      dependencies.aiService ??
      (config.ai?.mode === 'http' && config.ai?.serviceUrl
        ? aiModule.createHttpClient(config.ai.serviceUrl, {
            timeoutMs: config.ai.timeoutMs,
            fetchFn: dependencies.aiFetchFn,
            fallbackService: localAiService,
            logger: rootLogger,
          })
        : localAiService);

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
      aiService: aiService ?? undefined,
      whatsAppWebhookSecret:
        config.whatsapp.appSecret ?? 'commerce-whatsapp-webhook-secret',
      whatsAppVerifyToken: config.whatsapp.webhookVerifyToken,
    });
  }

  return app;
}
