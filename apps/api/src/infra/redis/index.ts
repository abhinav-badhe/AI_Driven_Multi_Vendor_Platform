import type { AppConfig } from '../../config/index.js';

/**
 * ARCHITECTURAL CONSTRAINT:
 * Redis is strictly restricted to ephemeral operations:
 * 1. Read caching
 * 2. Rate limiting counters
 * 3. Approved ephemeral session state
 *
 * Redis MUST NOT be used as a transactional source of truth, persistent storage,
 * or as a transactional message broker.
 */
export type ApprovedRedisUsage = 'cache' | 'rate-limiting' | 'ephemeral-state';

export interface RedisHealthStatus {
  status: 'healthy' | 'unhealthy' | 'disabled';
  details?: string;
}

export interface RedisService {
  readonly isConfigured: boolean;
  assertUsageAllowed(usage: ApprovedRedisUsage): void;
  checkHealth(): Promise<RedisHealthStatus>;
  shutdown(): Promise<void>;
}

export function createRedisService(config: AppConfig['redis']): RedisService {
  const isConfigured = Boolean(
    config.host && config.port && config.password !== 'placeholder_redis_password',
  );

  return {
    isConfigured,
    assertUsageAllowed(usage: ApprovedRedisUsage): void {
      const allowed: ApprovedRedisUsage[] = ['cache', 'rate-limiting', 'ephemeral-state'];
      if (!allowed.includes(usage)) {
        throw new Error(
          `Architectural violation: Redis usage '${usage}' is not permitted. Allowed uses: ${allowed.join(', ')}`,
        );
      }
    },
    async checkHealth(): Promise<RedisHealthStatus> {
      if (!isConfigured) {
        return {
          status: 'disabled',
          details: 'Redis is unconfigured or disabled for this environment.',
        };
      }
      return { status: 'healthy', details: 'Redis configuration active.' };
    },
    async shutdown(): Promise<void> {
      // Graceful client disconnect hook
    },
  };
}
