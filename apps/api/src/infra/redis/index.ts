import { Redis } from 'ioredis';
import type { AppConfig } from '../../config/index.js';
import type { Logger } from '../../observability/logger.js';

/**
 * ARCHITECTURAL CONSTRAINT:
 * Redis is strictly restricted to ephemeral operations:
 * 1. Read caching (derived data only — PostgreSQL remains the source of truth)
 * 2. Rate limiting counters
 * 3. Approved ephemeral session state
 *
 * Redis MUST NOT be used as a transactional source of truth, persistent storage,
 * or as a transactional message broker.
 */
export type ApprovedRedisUsage = 'cache' | 'rate-limiting' | 'ephemeral-state';

export interface RedisHealthStatus {
  status: 'healthy' | 'unhealthy' | 'disabled';
  details?: string | undefined;
}

export interface RedisService {
  readonly isConfigured: boolean;
  assertUsageAllowed(usage: ApprovedRedisUsage): void;
  checkHealth(): Promise<RedisHealthStatus>;
  /**
   * Returns the live client when Redis is reachable, otherwise null.
   * NEVER throws — callers must treat null as "cache unavailable" and
   * fall back to the authoritative PostgreSQL path (fail-open reads).
   */
  getClient(): Redis | null;
  /** True when a command may be issued without triggering a (re)connect. */
  isAvailable(): boolean;
  shutdown(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 1500;
const CIRCUIT_COOLDOWN_MS = 5000;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis operation timed out after ${ms}ms`)), ms);
    // Never keep the process alive for a cache probe.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

class IoredisService implements RedisService {
  readonly isConfigured: boolean;
  private client: Redis | null = null;
  private connecting: Promise<Redis | null> | null = null;
  private circuitOpenedAt: number | null = null;
  private lastLoggedDownAt = 0;

  constructor(
    private readonly config: AppConfig['redis'],
    private readonly logger?: Logger | undefined,
  ) {
    this.isConfigured = Boolean(
      config.host && config.port && config.password !== 'placeholder_redis_password',
    );
  }

  assertUsageAllowed(usage: ApprovedRedisUsage): void {
    const allowed: ApprovedRedisUsage[] = ['cache', 'rate-limiting', 'ephemeral-state'];
    if (!allowed.includes(usage)) {
      throw new Error(
        `Architectural violation: Redis usage '${usage}' is not permitted. Allowed uses: ${allowed.join(', ')}`,
      );
    }
  }

  isAvailable(): boolean {
    if (!this.isConfigured || !this.client) return false;
    if (this.circuitOpenedAt !== null) return false;
    return this.client.status === 'ready';
  }

  getClient(): Redis | null {
    if (!this.isConfigured) return null;
    if (this.client && this.client.status === 'ready' && this.circuitOpenedAt === null) {
      return this.client;
    }
    // Lazy (re)connect is async — kick it off without blocking the caller.
    // The current request falls back to the authoritative path; the next
    // request will observe the warmed connection.
    void this.ensureConnected();
    if (this.client && this.client.status === 'ready' && this.circuitOpenedAt === null) {
      return this.client;
    }
    return null;
  }

  async checkHealth(): Promise<RedisHealthStatus> {
    if (!this.isConfigured) {
      return {
        status: 'disabled',
        details: 'Redis is unconfigured or disabled for this environment.',
      };
    }
    const client = await this.ensureConnected();
    if (!client) {
      return { status: 'unhealthy', details: 'Redis is unreachable (circuit open or refused).' };
    }
    try {
      const pong = await withTimeout(client.ping(), CONNECT_TIMEOUT_MS);
      return { status: 'healthy', details: `Redis reachable (PING=${pong}).` };
    } catch (err) {
      this.openCircuit(err);
      return {
        status: 'unhealthy',
        details: `Redis PING failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async shutdown(): Promise<void> {
    this.connecting = null;
    if (this.client) {
      try {
        this.client.disconnect();
      } catch {
        // Disconnect is best-effort during teardown.
      }
      this.client = null;
    }
    this.circuitOpenedAt = null;
  }

  /**
   * Single-flight lazy connect. Resolves to a ready client or null.
   * Never throws and never leaves background retry loops behind:
   * ioredis auto-retry is disabled so a dead Redis cannot keep handles
   * open or spam reconnects — recovery is driven by explicit probes
   * after the circuit cooldown elapses.
   */
  private ensureConnected(): Promise<Redis | null> {
    if (!this.isConfigured) return Promise.resolve(null);
    if (this.client && this.client.status === 'ready' && this.circuitOpenedAt === null) {
      return Promise.resolve(this.client);
    }
    if (this.circuitOpenedAt !== null && Date.now() - this.circuitOpenedAt < CIRCUIT_COOLDOWN_MS) {
      return Promise.resolve(null);
    }
    if (!this.connecting) {
      this.connecting = this.connectOnce().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async connectOnce(): Promise<Redis | null> {
    try {
      if (!this.client) {
        const client = new Redis({
          host: this.config.host,
          port: this.config.port,
          password: this.config.password || undefined,
          tls: this.config.tls ? {} : undefined,
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          // No background retry loops: fail fast, recover via circuit probes.
          retryStrategy: () => null,
          connectTimeout: CONNECT_TIMEOUT_MS,
        });
        // ioredis emits 'error' on connection failures; without a listener
        // Node treats it as an uncaught exception and crashes the process.
        client.on('error', () => {
          // Swallowed intentionally — failures surface via command
          // rejections and the circuit breaker, never via process crash.
        });
        this.client = client;
      }
      await withTimeout(this.client.connect(), CONNECT_TIMEOUT_MS + 500);
      if (this.client.status !== 'ready') {
        throw new Error(`Redis client status is '${this.client.status}' after connect`);
      }
      if (this.circuitOpenedAt !== null) {
        this.logger?.info('Redis circuit closed — connection recovered');
      }
      this.circuitOpenedAt = null;
      return this.client;
    } catch (err) {
      this.openCircuit(err);
      return null;
    }
  }

  private openCircuit(err: unknown): void {
    this.circuitOpenedAt = Date.now();
    // Throttle outage logging to one line per cooldown window.
    if (Date.now() - this.lastLoggedDownAt > CIRCUIT_COOLDOWN_MS) {
      this.lastLoggedDownAt = Date.now();
      this.logger?.warn('Redis unavailable — failing open to authoritative path', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function createRedisService(
  config: AppConfig['redis'],
  logger?: Logger | undefined,
): RedisService {
  return new IoredisService(config, logger);
}
