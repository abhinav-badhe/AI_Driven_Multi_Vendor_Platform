import { z } from 'zod';

export const RawEnvSchema = z.object({
  // 1. Application / Runtime Configuration
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.string().regex(/^\d+$/).transform(Number),
  HOST: z.string().min(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),

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

  // 4. Observability Configuration
  SERVICE_NAME: z.string().min(1),
  LOG_PRETTY: z.string().transform((val) => val === 'true' || val === '1'),
  REDACT_KEYS: z.string().transform((val) =>
    val
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
  ),
});

export type RawEnv = z.infer<typeof RawEnvSchema>;

export interface AppConfig {
  app: {
    nodeEnv: 'development' | 'test' | 'production';
    port: number;
    host: string;
    logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
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
  observability: {
    serviceName: string;
    logPretty: boolean;
    redactKeys: string[];
  };
}
