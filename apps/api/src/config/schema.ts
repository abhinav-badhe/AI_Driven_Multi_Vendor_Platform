import { z } from 'zod';

export const RawEnvSchema = z.object({
  // 1. Application / Runtime Configuration
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.string().regex(/^\d+$/).transform(Number),
  HOST: z.string().min(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  CORS_ORIGINS: z.string().transform((val) => val.split(',').map(k => k.trim()).filter(Boolean)).optional(),

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
  SEARCH_STORE_ADAPTER: z.enum(['postgres', 'memory']).optional(),

  // 7. Email (Resend) Configuration — optional; without a key the API
  // keeps an in-memory outbox (dev/test) and logs instead of sending.
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(1).optional(),
  FRONTEND_URL: z.string().min(1).optional(),

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
  PAYMENT_PROVIDER: z.enum(['stripe', 'mock']).optional(),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  STRIPE_API_VERSION: z.string().min(1).optional(),
  STRIPE_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().optional(),

  // 10. Shipping / Carrier Gateway Configuration — optional; without credentials
  // the API uses the mock carrier provider for dev/test without network calls.
  CARRIER_PROVIDER: z.enum(['shippo', 'mock']).optional(),
  SHIPPO_API_KEY: z.string().min(1).optional(),
  SHIPPO_WEBHOOK_SECRET: z.string().min(1).optional(),
  SHIPPO_BASE_URL: z.string().url().optional(),
  SHIPPO_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  SHIPPO_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().optional(),
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
  };
  observability: {
    serviceName: string;
    logPretty: boolean;
    redactKeys: string[];
  };
  search: {
    storeAdapter: 'postgres' | 'memory';
  };
  notifications: {
    resendApiKey?: string | undefined;
    emailFrom: string;
    frontendUrl: string;
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
    provider: 'stripe' | 'mock';
    secretKey?: string | undefined;
    webhookSecret?: string | undefined;
    publishableKey?: string | undefined;
    apiVersion?: string | undefined;
    webhookToleranceSeconds: number;
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
