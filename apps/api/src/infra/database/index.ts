import type { AppConfig } from '../../config/index.js';

export interface DatabaseHealthStatus {
  status: 'healthy' | 'unhealthy' | 'unconfigured';
  details?: string;
}

export interface DatabaseService {
  readonly isConfigured: boolean;
  checkHealth(): Promise<DatabaseHealthStatus>;
  shutdown(): Promise<void>;
}

/**
 * Creates the PostgreSQL database connection boundary abstraction.
 * Note: Business schemas, migrations, and transactional outbox workflows
 * are explicitly deferred to subsequent phases.
 */
export function createDatabaseService(config: AppConfig['postgres']): DatabaseService {
  const isConfigured = Boolean(
    config.host &&
    config.database &&
    config.user &&
    config.password &&
    config.password !== 'placeholder_postgres_password',
  );

  return {
    isConfigured,
    async checkHealth(): Promise<DatabaseHealthStatus> {
      if (!isConfigured) {
        return {
          status: 'unconfigured',
          details: 'PostgreSQL credentials are using placeholders or are not configured.',
        };
      }
      // Live connection probe is implemented when DB driver/pool is initialized in domain phases
      return { status: 'healthy', details: 'Database configuration active.' };
    },
    async shutdown(): Promise<void> {
      // Graceful pool draining hook
    },
  };
}
