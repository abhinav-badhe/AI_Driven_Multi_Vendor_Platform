import dotenv from 'dotenv';
import { RawEnvSchema, type AppConfig } from './schema.js';

dotenv.config();

export class ConfigurationError extends Error {
  public readonly issues: Array<{ field: string; message: string }>;

  constructor(message: string, issues: Array<{ field: string; message: string }>) {
    super(message);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

export function parseConfig(envSource: Record<string, string | undefined>): AppConfig {
  const env: Record<string, string | undefined> = { ...envSource };

  if (env.DATABASE_URL) {
    try {
      const parsed = new URL(env.DATABASE_URL);
      env.DATABASE_HOST = parsed.hostname;
      env.DATABASE_PORT = parsed.port || '5432';
      env.DATABASE_NAME = parsed.pathname.replace(/^\//, '');
      env.DATABASE_USER = decodeURIComponent(parsed.username);
      env.DATABASE_PASSWORD = decodeURIComponent(parsed.password);
    } catch {
      // fallback to schema validation errors
    }
  }

  // Resilient defaults for containerized/cloud deployments
  if (!env.DATABASE_POOL_MIN) env.DATABASE_POOL_MIN = '1';
  if (!env.DATABASE_POOL_MAX) env.DATABASE_POOL_MAX = '10';
  if (!env.REDIS_HOST) env.REDIS_HOST = '127.0.0.1';
  if (!env.REDIS_PORT) env.REDIS_PORT = '6379';
  if (!env.REDIS_TLS) env.REDIS_TLS = 'false';
  if (!env.SERVICE_NAME) env.SERVICE_NAME = 'commerce-api';
  if (!env.LOG_LEVEL) env.LOG_LEVEL = env.NODE_ENV === 'production' ? 'info' : 'debug';
  if (!env.LOG_PRETTY) env.LOG_PRETTY = env.NODE_ENV === 'production' ? 'false' : 'true';
  if (!env.REDACT_KEYS) env.REDACT_KEYS = 'password,token,secret,key,authorization';
  if (!env.HOST) env.HOST = '0.0.0.0';
  if (!env.PORT) env.PORT = env.PORT || '4000';

  const result = RawEnvSchema.safeParse(env);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    const missingKeys = issues.map((i) => `  - ${i.field}: ${i.message}`).join('\n');
    throw new ConfigurationError(
      `Invalid or missing environment configuration:\n${missingKeys}`,
      issues,
    );
  }

  const raw = result.data;

  return {
    app: {
      nodeEnv: raw.NODE_ENV,
      port: raw.PORT,
      host: raw.HOST,
      logLevel: raw.LOG_LEVEL,
      corsOrigins: raw.CORS_ORIGINS,
    },
    postgres: {
      host: raw.DATABASE_HOST,
      port: raw.DATABASE_PORT,
      database: raw.DATABASE_NAME,
      user: raw.DATABASE_USER,
      password: raw.DATABASE_PASSWORD,
      poolMin: raw.DATABASE_POOL_MIN,
      poolMax: raw.DATABASE_POOL_MAX,
    },
    redis: {
      host: raw.REDIS_HOST,
      port: raw.REDIS_PORT,
      password: raw.REDIS_PASSWORD || undefined,
      tls: raw.REDIS_TLS,
    },
    identity: {
      accessTokenSecret: raw.ACCESS_TOKEN_SECRET,
      accessTokenTtlSeconds: raw.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: raw.REFRESH_TOKEN_TTL_SECONDS,
      verificationMode: raw.AUTH_VERIFICATION_MODE,
    },
    observability: {
      serviceName: raw.SERVICE_NAME,
      logPretty: raw.LOG_PRETTY,
      redactKeys: raw.REDACT_KEYS,
    },
    search: {
      storeAdapter: raw.SEARCH_STORE_ADAPTER ?? 'postgres',
      serviceUrl: raw.SEARCH_SERVICE_URL || undefined,
      timeoutMs: raw.SEARCH_SERVICE_TIMEOUT_MS,
    },
    recommendations: {
      storeAdapter: raw.RECOMMENDATION_STORE_ADAPTER ?? 'postgres',
      serviceUrl: raw.RECOMMENDATION_SERVICE_URL || undefined,
      timeoutMs: raw.RECOMMENDATION_SERVICE_TIMEOUT_MS,
    },
    analytics: {
      mode: raw.ANALYTICS_SERVICE_MODE ?? 'local',
      serviceUrl: raw.ANALYTICS_SERVICE_URL || undefined,
      timeoutMs: raw.ANALYTICS_SERVICE_TIMEOUT_MS,
    },
    customer: {
      mode: raw.CUSTOMER_SERVICE_MODE ?? 'local',
      serviceUrl: raw.CUSTOMER_SERVICE_URL || undefined,
      timeoutMs: raw.CUSTOMER_SERVICE_TIMEOUT_MS,
    },
    promotion: {
      mode: raw.PROMOTION_SERVICE_MODE ?? 'local',
      serviceUrl: raw.PROMOTION_SERVICE_URL || undefined,
      timeoutMs: raw.PROMOTION_SERVICE_TIMEOUT_MS,
    },
    merchant: {
      mode: raw.MERCHANT_SERVICE_MODE ?? 'local',
      serviceUrl: raw.MERCHANT_SERVICE_URL || undefined,
      timeoutMs: raw.MERCHANT_SERVICE_TIMEOUT_MS,
    },
    catalog: {
      mode: raw.CATALOG_SERVICE_MODE ?? 'local',
      serviceUrl: raw.CATALOG_SERVICE_URL || undefined,
      timeoutMs: raw.CATALOG_SERVICE_TIMEOUT_MS,
    },
    marketplace: {
      mode: raw.MARKETPLACE_SERVICE_MODE ?? 'local',
      serviceUrl: raw.MARKETPLACE_SERVICE_URL || undefined,
      timeoutMs: raw.MARKETPLACE_SERVICE_TIMEOUT_MS,
    },
    inventory: {
      mode: raw.INVENTORY_SERVICE_MODE ?? 'local',
      serviceUrl: raw.INVENTORY_SERVICE_URL || undefined,
      timeoutMs: raw.INVENTORY_SERVICE_TIMEOUT_MS,
    },
    cart: {
      mode: raw.CART_SERVICE_MODE ?? 'local',
      serviceUrl: raw.CART_SERVICE_URL || undefined,
      timeoutMs: raw.CART_SERVICE_TIMEOUT_MS,
    },
    checkout: {
      mode: raw.CHECKOUT_SERVICE_MODE ?? 'local',
      serviceUrl: raw.CHECKOUT_SERVICE_URL || undefined,
      timeoutMs: raw.CHECKOUT_SERVICE_TIMEOUT_MS,
    },
    orders: {
      mode: raw.ORDER_SERVICE_MODE ?? 'local',
      serviceUrl: raw.ORDER_SERVICE_URL || undefined,
      timeoutMs: raw.ORDER_SERVICE_TIMEOUT_MS,
    },
    notifications: {
      resendApiKey: raw.RESEND_API_KEY || undefined,
      // Strip stray wrapping quotes/backticks/whitespace so a typo in
      // EMAIL_FROM fails loudly at Resend instead of silently poisoning
      // every send (e.g. `Store <onboarding@resend.dev>` with a backtick).
      emailFrom: (raw.EMAIL_FROM ?? 'Store <onboarding@resend.dev>')
        .trim()
        .replace(/^[`'"]+|[`'"]+$/g, '')
        .trim(),
      frontendUrl: raw.FRONTEND_URL ?? 'http://localhost:3000',
      clientMode: raw.NOTIFICATION_CLIENT_MODE,
      serviceUrl: raw.NOTIFICATION_SERVICE_URL || undefined,
      serviceKey: raw.NOTIFICATION_SERVICE_KEY || undefined,
      timeoutMs: raw.NOTIFICATION_SERVICE_TIMEOUT_MS,
    },
    ml: {
      executionMode: raw.ML_EXECUTION_MODE,
      serviceUrl: raw.ML_SERVICE_URL || undefined,
      timeoutMs: raw.ML_SERVICE_TIMEOUT_MS,
    },
    whatsapp: {
      provider:
        raw.WHATSAPP_PROVIDER ??
        (raw.WHATSAPP_ACCESS_TOKEN && raw.WHATSAPP_PHONE_NUMBER_ID && raw.WHATSAPP_APP_SECRET
          ? 'meta'
          : 'mock'),
      accessToken: raw.WHATSAPP_ACCESS_TOKEN || undefined,
      phoneNumberId: raw.WHATSAPP_PHONE_NUMBER_ID || undefined,
      appSecret: raw.WHATSAPP_APP_SECRET || undefined,
      webhookVerifyToken: raw.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? 'commerce_wa_verify_token_default',
      apiVersion: raw.WHATSAPP_API_VERSION ?? 'v20.0',
    },
    payment: {
      mode: raw.PAYMENT_SERVICE_MODE ?? 'local',
      serviceUrl: raw.PAYMENT_SERVICE_URL || undefined,
      timeoutMs: raw.PAYMENT_SERVICE_TIMEOUT_MS,
      provider:
        raw.PAYMENT_PROVIDER ??
        (raw.RAZORPAY_KEY_ID
          ? 'razorpay'
          : raw.STRIPE_SECRET_KEY && raw.STRIPE_SECRET_KEY.startsWith('sk_')
          ? 'stripe'
          : 'mock'),
      secretKey: raw.STRIPE_SECRET_KEY || undefined,
      webhookSecret: raw.STRIPE_WEBHOOK_SECRET || raw.RAZORPAY_WEBHOOK_SECRET || 'whsec_mock_default_secret_for_tests',
      publishableKey: raw.STRIPE_PUBLISHABLE_KEY || undefined,
      apiVersion: raw.STRIPE_API_VERSION || undefined,
      webhookToleranceSeconds: raw.STRIPE_WEBHOOK_TOLERANCE_SECONDS ?? 300,
      razorpayKeyId: raw.RAZORPAY_KEY_ID || undefined,
      razorpayKeySecret: raw.RAZORPAY_KEY_SECRET || undefined,
      razorpayWebhookSecret: raw.RAZORPAY_WEBHOOK_SECRET || undefined,
    },
    fulfillment: {
      mode: raw.FULFILLMENT_SERVICE_MODE ?? 'local',
      serviceUrl: raw.FULFILLMENT_SERVICE_URL || undefined,
      timeoutMs: raw.FULFILLMENT_SERVICE_TIMEOUT_MS,
    },
    settlement: {
      mode: raw.SETTLEMENT_SERVICE_MODE ?? 'local',
      serviceUrl: raw.SETTLEMENT_SERVICE_URL || undefined,
      timeoutMs: raw.SETTLEMENT_SERVICE_TIMEOUT_MS,
    },
    eventBroker: {
      mode: raw.EVENT_BROKER_MODE ?? 'local',
      serviceUrl: raw.EVENT_BROKER_URL || undefined,
      timeoutMs: raw.EVENT_BROKER_TIMEOUT_MS,
    },
    ai: {
      mode: raw.AI_SERVICE_MODE ?? 'local',
      serviceUrl: raw.AI_SERVICE_URL || undefined,
      timeoutMs: raw.AI_SERVICE_TIMEOUT_MS,
    },
    shipping: {
      provider:
        raw.CARRIER_PROVIDER ??
        (raw.SHIPPO_API_KEY && raw.SHIPPO_API_KEY.startsWith('shippo_') ? 'shippo' : 'mock'),
      apiKey: raw.SHIPPO_API_KEY || undefined,
      webhookSecret: raw.SHIPPO_WEBHOOK_SECRET || 'whsec_carrier_mock_secret',
      baseUrl: raw.SHIPPO_BASE_URL || 'https://api.goshippo.com',
      timeoutMs: raw.SHIPPO_TIMEOUT_MS ?? 10000,
      webhookToleranceSeconds: raw.SHIPPO_WEBHOOK_TOLERANCE_SECONDS ?? 300,
    },
  };
}

let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = parseConfig(process.env);
  }
  return cachedConfig;
}

export * from './schema.js';
