import { z } from 'zod';

export const RawEnvSchema = z
  .object({
    // 1. Application / Runtime Configuration
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: z.string().regex(/^\d+$/).transform(Number),
    HOST: z.string().min(1),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
    CORS_ORIGINS: z
      .string()
      .transform((val) =>
        val
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean),
      )
      .optional(),

    // 2. PostgreSQL Configuration
    DATABASE_HOST: z.string().min(1),
    DATABASE_PORT: z.string().regex(/^\d+$/).transform(Number),
    DATABASE_NAME: z.string().min(1),
    DATABASE_USER: z.string().min(1),
    DATABASE_PASSWORD: z.string().min(1),
    DATABASE_POOL_MIN: z.string().regex(/^\d+$/).transform(Number),
    DATABASE_POOL_MAX: z.string().regex(/^\d+$/).transform(Number),

    // 3. Redis Configuration (Ephemerality Boundary)
    REDIS_HOST: z.string().min(1),
    REDIS_PORT: z.string().regex(/^\d+$/).transform(Number),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_TLS: z.string().transform((val) => val === 'true' || val === '1'),

    // 4. Identity / Auth Configuration
    ACCESS_TOKEN_SECRET: z.string().min(16),
    ACCESS_TOKEN_TTL_SECONDS: z.string().regex(/^\d+$/).transform(Number).optional(),
    REFRESH_TOKEN_TTL_SECONDS: z.string().regex(/^\d+$/).transform(Number).optional(),
    AUTH_VERIFICATION_MODE: z
      .string()
      .optional()
      .transform((val) => {
        if (!val || !val.trim()) return 'dynamic';
        return val.trim().toLowerCase();
      })
      .pipe(z.enum(['dynamic', 'stateless', 'gateway'])),

    // 5. Observability Configuration
    SERVICE_NAME: z.string().min(1),
    LOG_PRETTY: z.string().transform((val) => val === 'true' || val === '1'),
    REDACT_KEYS: z.string().transform((val) =>
      val
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    ),

    // 6. Search Configuration
    SEARCH_STORE_ADAPTER: z.enum(['postgres', 'memory', 'http']).optional(),
    SEARCH_SERVICE_URL: z.string().url().optional(),
    SEARCH_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

    // 6.5. Recommendations Configuration
    RECOMMENDATION_STORE_ADAPTER: z.enum(['postgres', 'memory', 'http']).optional(),
    RECOMMENDATION_SERVICE_URL: z.string().url().optional(),
    RECOMMENDATION_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

    // 6.7. Analytics Configuration
    ANALYTICS_SERVICE_MODE: z.enum(['local', 'http']).default('local'),
    ANALYTICS_SERVICE_URL: z.string().url().optional(),
    ANALYTICS_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

    // 6.8. Customer Service Configuration
    CUSTOMER_SERVICE_MODE: z.enum(['local', 'http']).default('local'),
    CUSTOMER_SERVICE_URL: z.string().url().optional(),
    CUSTOMER_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

    // 6.9. Promotion Service Configuration
    PROMOTION_SERVICE_MODE: z.enum(['local', 'http']).default('local'),
    PROMOTION_SERVICE_URL: z.string().url().optional(),
    PROMOTION_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

    // 6.10. Merchant Service Configuration
    MERCHANT_SERVICE_MODE: z.enum(['local', 'http']).default('local'),
    MERCHANT_SERVICE_URL: z.string().url().optional(),
    MERCHANT_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

    // 6.11. Catalog Service Configuration
    CATALOG_SERVICE_MODE: z.enum(['local', 'http']).default('local'),
    CATALOG_SERVICE_URL: z.string().url().optional(),
    CATALOG_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

    // 6.12. Marketplace Service Configuration
    MARKETPLACE_SERVICE_MODE: z.enum(['local', 'http']).default('local'),
    MARKETPLACE_SERVICE_URL: z.string().url().optional(),
    MARKETPLACE_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

    // 6.13. Inventory Service Configuration
    INVENTORY_SERVICE_MODE: z.enum(['local', 'http']).default('local'),
    INVENTORY_SERVICE_URL: z.string().url().optional(),
    INVENTORY_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

    // 6.14. Cart Service Configuration
    CART_SERVICE_MODE: z.enum(['local', 'http']).default('local'),
    CART_SERVICE_URL: z.string().url().optional(),
    CART_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

    // 6.15. Checkout Service Configuration
    CHECKOUT_SERVICE_MODE: z.enum(['local', 'http']).default('local'),
    CHECKOUT_SERVICE_URL: z.string().url().optional(),
    CHECKOUT_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

    // 6.16. Order Service Configuration
    ORDER_SERVICE_MODE: z.enum(['local', 'http']).default('local'),
    ORDER_SERVICE_URL: z.string().url().optional(),
    ORDER_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

    // 7. Email (Resend) and Standalone Notifications Service Configuration
    RESEND_API_KEY: z.string().min(1).optional(),
    EMAIL_FROM: z.string().min(1).optional(),
    FRONTEND_URL: z.string().min(1).optional(),
    NOTIFICATION_CLIENT_MODE: z
      .string()
      .optional()
      .transform((val) => {
        if (!val || !val.trim()) return 'local';
        return val.trim().toLowerCase();
      })
      .pipe(z.enum(['local', 'http'])),
    NOTIFICATION_SERVICE_URL: z
      .string()
      .optional()
      .transform((val) => (val && val.trim() ? val.trim() : undefined))
      .pipe(z.string().url().optional()),
    NOTIFICATION_SERVICE_KEY: z
      .string()
      .optional()
      .transform((val) => (val && val.trim() ? val.trim() : undefined))
      .pipe(
        z.string().min(16, 'NOTIFICATION_SERVICE_KEY must be at least 16 characters').optional(),
      ),
    NOTIFICATION_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

    // 8. WhatsApp Cloud API Configuration — optional; without credentials
    // the API uses the mock provider for dev/test without network calls.
    WHATSAPP_PROVIDER: z.enum(['meta', 'mock']).optional(),
    WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),
    WHATSAPP_APP_SECRET: z.string().min(1).optional(),
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().min(1).optional(),
    WHATSAPP_API_VERSION: z.string().min(1).optional(),

    // 9. Payment Gateway Configuration — optional; without credentials
    // the API uses the mock provider for dev/test without network calls.
    PAYMENT_PROVIDER: z.enum(['stripe', 'razorpay', 'mock']).optional(),
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    STRIPE_PUBLISHABLE_KEY: z.string().min(1).optional(),
    STRIPE_API_VERSION: z.string().min(1).optional(),
    STRIPE_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().optional(),
    RAZORPAY_KEY_ID: z.string().min(1).optional(),
    RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
    PAYMENT_SERVICE_MODE: z
      .string()
      .optional()
      .transform((val) => {
        if (!val || !val.trim()) return 'local';
        return val.trim().toLowerCase();
      })
      .pipe(z.enum(['local', 'http'])),
    PAYMENT_SERVICE_URL: z
      .string()
      .optional()
      .transform((val) => (val && val.trim() ? val.trim() : undefined))
      .pipe(z.string().url().optional()),
    PAYMENT_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

    // 10. Shipping / Carrier Gateway Configuration — optional; without credentials
    // the API uses the mock carrier provider for dev/test without network calls.
    CARRIER_PROVIDER: z.enum(['shippo', 'mock']).optional(),
    SHIPPO_API_KEY: z.string().min(1).optional(),
    SHIPPO_WEBHOOK_SECRET: z.string().min(1).optional(),
    SHIPPO_BASE_URL: z.string().url().optional(),
    SHIPPO_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    SHIPPO_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().optional(),
    FULFILLMENT_SERVICE_MODE: z
      .string()
      .optional()
      .transform((val) => {
        if (!val || !val.trim()) return 'local';
        return val.trim().toLowerCase();
      })
      .pipe(z.enum(['local', 'http'])),
    FULFILLMENT_SERVICE_URL: z
      .string()
      .optional()
      .transform((val) => (val && val.trim() ? val.trim() : undefined))
      .pipe(z.string().url().optional()),
    FULFILLMENT_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    SETTLEMENT_SERVICE_MODE: z
      .string()
      .optional()
      .transform((val) => {
        if (!val || !val.trim()) return 'local';
        return val.trim().toLowerCase();
      })
      .pipe(z.enum(['local', 'http'])),
    SETTLEMENT_SERVICE_URL: z
      .string()
      .optional()
      .transform((val) => (val && val.trim() ? val.trim() : undefined))
      .pipe(z.string().url().optional()),
    SETTLEMENT_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    EVENT_BROKER_MODE: z
      .string()
      .optional()
      .transform((val) => {
        if (!val || !val.trim()) return 'local';
        return val.trim().toLowerCase();
      })
      .pipe(z.enum(['local', 'http'])),
    EVENT_BROKER_URL: z
      .string()
      .optional()
      .transform((val) => (val && val.trim() ? val.trim() : undefined))
      .pipe(z.string().url().optional()),
    EVENT_BROKER_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    AI_SERVICE_MODE: z
      .string()
      .optional()
      .transform((val) => {
        if (!val || !val.trim()) return 'local';
        return val.trim().toLowerCase();
      })
      .pipe(z.enum(['local', 'http'])),
    AI_SERVICE_URL: z
      .string()
      .optional()
      .transform((val) => (val && val.trim() ? val.trim() : undefined))
      .pipe(z.string().url().optional()),
    AI_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

    // 11. ML Inference Service Configuration — optional; defaults to local Python runner.
    ML_EXECUTION_MODE: z
      .string()
      .optional()
      .transform((val) => {
        if (!val || !val.trim()) return 'local';
        return val.trim().toLowerCase();
      })
      .pipe(z.enum(['local', 'http'])),
    ML_SERVICE_URL: z
      .string()
      .optional()
      .transform((val) => (val && val.trim() ? val.trim() : undefined))
      .pipe(z.string().url().optional()),
    ML_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  })
  .superRefine((data, ctx) => {
    if (data.NOTIFICATION_CLIENT_MODE === 'http') {
      if (!data.NOTIFICATION_SERVICE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'NOTIFICATION_SERVICE_URL is required when NOTIFICATION_CLIENT_MODE is http',
          path: ['NOTIFICATION_SERVICE_URL'],
        });
      }
      if (!data.NOTIFICATION_SERVICE_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'NOTIFICATION_SERVICE_KEY is required when NOTIFICATION_CLIENT_MODE is http (minimum 16 characters)',
          path: ['NOTIFICATION_SERVICE_KEY'],
        });
      }
    }

    if (data.ML_EXECUTION_MODE === 'http') {
      if (!data.ML_SERVICE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'ML_SERVICE_URL is required when ML_EXECUTION_MODE is http',
          path: ['ML_SERVICE_URL'],
        });
      }
    }

    if (data.SEARCH_STORE_ADAPTER === 'http') {
      if (!data.SEARCH_SERVICE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'SEARCH_SERVICE_URL is required when SEARCH_STORE_ADAPTER is http',
          path: ['SEARCH_SERVICE_URL'],
        });
      }
    }

    if (data.RECOMMENDATION_STORE_ADAPTER === 'http') {
      if (!data.RECOMMENDATION_SERVICE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'RECOMMENDATION_SERVICE_URL is required when RECOMMENDATION_STORE_ADAPTER is http',
          path: ['RECOMMENDATION_SERVICE_URL'],
        });
      }
    }

    if (data.ANALYTICS_SERVICE_MODE === 'http') {
      if (!data.ANALYTICS_SERVICE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'ANALYTICS_SERVICE_URL is required when ANALYTICS_SERVICE_MODE is http',
          path: ['ANALYTICS_SERVICE_URL'],
        });
      }
    }

    if (data.CUSTOMER_SERVICE_MODE === 'http') {
      if (!data.CUSTOMER_SERVICE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CUSTOMER_SERVICE_URL is required when CUSTOMER_SERVICE_MODE is http',
          path: ['CUSTOMER_SERVICE_URL'],
        });
      }
    }

    if (data.PROMOTION_SERVICE_MODE === 'http') {
      if (!data.PROMOTION_SERVICE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'PROMOTION_SERVICE_URL is required when PROMOTION_SERVICE_MODE is http',
          path: ['PROMOTION_SERVICE_URL'],
        });
      }
    }

    if (data.MERCHANT_SERVICE_MODE === 'http') {
      if (!data.MERCHANT_SERVICE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'MERCHANT_SERVICE_URL is required when MERCHANT_SERVICE_MODE is http',
          path: ['MERCHANT_SERVICE_URL'],
        });
      }
    }

    if (data.CATALOG_SERVICE_MODE === 'http') {
      if (!data.CATALOG_SERVICE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CATALOG_SERVICE_URL is required when CATALOG_SERVICE_MODE is http',
          path: ['CATALOG_SERVICE_URL'],
        });
      }
    }

    if (data.MARKETPLACE_SERVICE_MODE === 'http') {
      if (!data.MARKETPLACE_SERVICE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'MARKETPLACE_SERVICE_URL is required when MARKETPLACE_SERVICE_MODE is http',
          path: ['MARKETPLACE_SERVICE_URL'],
        });
      }
    }

    if (data.INVENTORY_SERVICE_MODE === 'http') {
      if (!data.INVENTORY_SERVICE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'INVENTORY_SERVICE_URL is required when INVENTORY_SERVICE_MODE is http',
          path: ['INVENTORY_SERVICE_URL'],
        });
      }
    }

    if (data.CART_SERVICE_MODE === 'http') {
      if (!data.CART_SERVICE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CART_SERVICE_URL is required when CART_SERVICE_MODE is http',
          path: ['CART_SERVICE_URL'],
        });
      }
    }

    if (data.CHECKOUT_SERVICE_MODE === 'http') {
      if (!data.CHECKOUT_SERVICE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CHECKOUT_SERVICE_URL is required when CHECKOUT_SERVICE_MODE is http',
          path: ['CHECKOUT_SERVICE_URL'],
        });
      }
    }

    if (data.ORDER_SERVICE_MODE === 'http') {
      if (!data.ORDER_SERVICE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'ORDER_SERVICE_URL is required when ORDER_SERVICE_MODE is http',
          path: ['ORDER_SERVICE_URL'],
        });
      }
    }

    if (data.PAYMENT_SERVICE_MODE === 'http') {
      if (!data.PAYMENT_SERVICE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'PAYMENT_SERVICE_URL is required when PAYMENT_SERVICE_MODE is http',
          path: ['PAYMENT_SERVICE_URL'],
        });
      }
    }

    if (data.FULFILLMENT_SERVICE_MODE === 'http') {
      if (!data.FULFILLMENT_SERVICE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'FULFILLMENT_SERVICE_URL is required when FULFILLMENT_SERVICE_MODE is http',
          path: ['FULFILLMENT_SERVICE_URL'],
        });
      }
    }

    if (data.SETTLEMENT_SERVICE_MODE === 'http') {
      if (!data.SETTLEMENT_SERVICE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'SETTLEMENT_SERVICE_URL is required when SETTLEMENT_SERVICE_MODE is http',
          path: ['SETTLEMENT_SERVICE_URL'],
        });
      }
    }

    if (data.EVENT_BROKER_MODE === 'http') {
      if (!data.EVENT_BROKER_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'EVENT_BROKER_URL is required when EVENT_BROKER_MODE is http',
          path: ['EVENT_BROKER_URL'],
        });
      }
    }

    if (data.AI_SERVICE_MODE === 'http') {
      if (!data.AI_SERVICE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'AI_SERVICE_URL is required when AI_SERVICE_MODE is http',
          path: ['AI_SERVICE_URL'],
        });
      }
    }
  });

export type RawEnv = z.infer<typeof RawEnvSchema>;

export interface AppConfig {
  app: {
    nodeEnv: 'development' | 'test' | 'production';
    port: number;
    host: string;
    logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
    corsOrigins?: string[] | undefined;
  };
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    poolMin: number;
    poolMax: number;
  };
  redis: {
    host: string;
    port: number;
    password?: string | undefined;
    tls: boolean;
  };
  identity: {
    accessTokenSecret: string;
    accessTokenTtlSeconds?: number | undefined;
    refreshTokenTtlSeconds?: number | undefined;
    verificationMode: 'dynamic' | 'stateless' | 'gateway';
  };
  observability: {
    serviceName: string;
    logPretty: boolean;
    redactKeys: string[];
  };
  search: {
    storeAdapter: 'postgres' | 'memory' | 'http';
    serviceUrl?: string | undefined;
    timeoutMs: number;
  };
  recommendations: {
    storeAdapter: 'postgres' | 'memory' | 'http';
    serviceUrl?: string | undefined;
    timeoutMs: number;
  };
  analytics: {
    mode: 'local' | 'http';
    serviceUrl?: string | undefined;
    timeoutMs: number;
  };
  customer: {
    mode: 'local' | 'http';
    serviceUrl?: string | undefined;
    timeoutMs: number;
  };
  promotion: {
    mode: 'local' | 'http';
    serviceUrl?: string | undefined;
    timeoutMs: number;
  };
  merchant: {
    mode: 'local' | 'http';
    serviceUrl?: string | undefined;
    timeoutMs: number;
  };
  catalog: {
    mode: 'local' | 'http';
    serviceUrl?: string | undefined;
    timeoutMs: number;
  };
  marketplace: {
    mode: 'local' | 'http';
    serviceUrl?: string | undefined;
    timeoutMs: number;
  };
  inventory: {
    mode: 'local' | 'http';
    serviceUrl?: string | undefined;
    timeoutMs: number;
  };
  cart: {
    mode: 'local' | 'http';
    serviceUrl?: string | undefined;
    timeoutMs: number;
  };
  checkout: {
    mode: 'local' | 'http';
    serviceUrl?: string | undefined;
    timeoutMs: number;
  };
  orders: {
    mode: 'local' | 'http';
    serviceUrl?: string | undefined;
    timeoutMs: number;
  };
  notifications: {
    resendApiKey?: string | undefined;
    emailFrom: string;
    frontendUrl: string;
    clientMode: 'local' | 'http';
    serviceUrl?: string | undefined;
    serviceKey?: string | undefined;
    timeoutMs: number;
  };
  ml: {
    executionMode: 'local' | 'http';
    serviceUrl?: string | undefined;
    timeoutMs: number;
  };
  whatsapp: {
    provider: 'meta' | 'mock';
    accessToken?: string | undefined;
    phoneNumberId?: string | undefined;
    appSecret?: string | undefined;
    webhookVerifyToken: string;
    apiVersion: string;
  };
  payment: {
    mode: 'local' | 'http';
    serviceUrl?: string | undefined;
    timeoutMs: number;
    provider: 'stripe' | 'razorpay' | 'mock';
    secretKey?: string | undefined;
    webhookSecret?: string | undefined;
    publishableKey?: string | undefined;
    apiVersion?: string | undefined;
    webhookToleranceSeconds: number;
    razorpayKeyId?: string | undefined;
    razorpayKeySecret?: string | undefined;
    razorpayWebhookSecret?: string | undefined;
  };
  fulfillment: {
    mode: 'local' | 'http';
    serviceUrl?: string | undefined;
    timeoutMs: number;
  };
  settlement: {
    mode: 'local' | 'http';
    serviceUrl?: string | undefined;
    timeoutMs: number;
  };
  eventBroker: {
    mode: 'local' | 'http';
    serviceUrl?: string | undefined;
    timeoutMs: number;
  };
  ai: {
    mode: 'local' | 'http';
    serviceUrl?: string | undefined;
    timeoutMs: number;
  };
  shipping: {
    provider: 'shippo' | 'mock';
    apiKey?: string | undefined;
    webhookSecret: string;
    baseUrl: string;
    timeoutMs: number;
    webhookToleranceSeconds: number;
  };
}
