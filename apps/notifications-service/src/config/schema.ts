import { z } from 'zod';

export const configSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(4005),
    HOST: z.string().default('0.0.0.0'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // Database settings
    DATABASE_URL: z.string().optional(),
    DATABASE_HOST: z.string().default('localhost'),
    DATABASE_PORT: z.coerce.number().int().default(5432),
    DATABASE_NAME: z.string().default('notifications_db'),
    DATABASE_USER: z.string().default('postgres'),
    DATABASE_PASSWORD: z.string().default(''),
    DATABASE_POOL_MIN: z.coerce.number().int().default(1),
    DATABASE_POOL_MAX: z.coerce.number().int().default(10),

    // Authentication: HMAC secret matching the monolith access token secret
    JWT_SECRET: z.string().min(16),

    // Internal service-to-service authentication key
    INTERNAL_SERVICE_KEY: z
      .string()
      .min(16)
      .default('development-internal-service-key-min-16-chars'),

    // Channel provider settings
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default('notifications@example.com'),

    // Retry & Processing defaults
    BATCH_SIZE: z.coerce.number().int().positive().default(50),
    BASE_RETRY_DELAY_MS: z.coerce.number().int().positive().default(1000),
    MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
    CONSUMER_RECEIPT_STALE_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  })
  .refine(
    (data) => {
      if (
        data.NODE_ENV === 'production' &&
        (!data.INTERNAL_SERVICE_KEY ||
          data.INTERNAL_SERVICE_KEY === 'development-internal-service-key-min-16-chars')
      ) {
        return false;
      }
      return true;
    },
    {
      message:
        'INTERNAL_SERVICE_KEY must be explicitly configured with a secure value in production (minimum 16 characters)',
      path: ['INTERNAL_SERVICE_KEY'],
    },
  );

export type RawConfig = z.infer<typeof configSchema>;
export type { NotificationsConfig } from './index.js';
