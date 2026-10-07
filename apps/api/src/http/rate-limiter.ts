import type { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '../errors/app-error.js';
import { withTimeout, type RedisService } from '../infra/redis/index.js';
import {
  CACHE_KEY_PREFIX,
  CACHE_OP_TIMEOUT_MS,
  resolveCacheClient,
  type CacheClient,
} from '../infra/redis/cache.js';

export class TooManyRequestsError extends AppError {
  public readonly statusCode = 429;
  public readonly code = 'TOO_MANY_REQUESTS';
}

export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
}

export interface RateLimiter {
  check(key: string): boolean | Promise<boolean>;
  middleware(): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/**
 * Builds a stable per-route key. Prefers the matched route pattern so
 * equivalent URLs with different query strings share one window —
 * this keeps cardinality bounded and closes the trivial
 * random-query-param bypass of pure-URL keys.
 */
function requestKey(request: FastifyRequest): string {
  const routerPath = (request as { routerPath?: unknown }).routerPath;
  const path =
    typeof routerPath === 'string' && routerPath.length > 0
      ? routerPath
      : String(request.url ?? '').split('?')[0];
  return `${request.ip}:${path}`;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, { count: number; expiresAt: number }>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(options?: Partial<RateLimiterOptions>) {
    this.windowMs = options?.windowMs ?? 60_000; // 1 minute default
    this.maxRequests = options?.maxRequests ?? 20; // 20 requests per window default
  }

  check(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);

    if (!entry || entry.expiresAt <= now) {
      this.hits.set(key, { count: 1, expiresAt: now + this.windowMs });
      return true;
    }

    if (entry.count >= this.maxRequests) {
      return false;
    }

    entry.count += 1;
    return true;
  }

  middleware() {
    return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      const allowed = this.check(requestKey(request));
      if (!allowed) {
        throw new TooManyRequestsError(
          'Too many requests. Please slow down and try again later.',
        );
      }
    };
  }
}

/**
 * Distributed fixed-window rate limiter backed by Redis (INCR + EXPIRE).
 * Fails OPEN: when Redis is unreachable the request is allowed so a
 * cache outage can never become a full API outage. Pair with
 * CompositeRateLimiter so local enforcement continues during flaps.
 */
export class RedisRateLimiter implements RateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(
    private readonly redisService: RedisService,
    options?: Partial<RateLimiterOptions>,
    private readonly clientOverride?: CacheClient | undefined,
    private readonly keyPrefix = 'rl',
  ) {
    this.redisService.assertUsageAllowed('rate-limiting');
    this.windowMs = options?.windowMs ?? 60_000;
    this.maxRequests = options?.maxRequests ?? 20;
  }

  async check(key: string): Promise<boolean> {
    const client = resolveCacheClient(this.redisService, this.clientOverride);
    if (!client) return true;
    try {
      const windowSec = Math.max(1, Math.floor(this.windowMs / 1000));
      const redisKey = `${CACHE_KEY_PREFIX}:${this.keyPrefix}:${key}`;
      // Create-with-TTL first so a crash between INCR and EXPIRE
      // can never leak a TTL-less counter key.
      await withTimeout(client.setNxEx(redisKey, '0', windowSec), CACHE_OP_TIMEOUT_MS);
      const count = await withTimeout(client.incr(redisKey), CACHE_OP_TIMEOUT_MS);
      return count <= this.maxRequests;
    } catch {
      return true;
    }
  }

  middleware() {
    return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      const allowed = await this.check(requestKey(request));
      if (!allowed) {
        throw new TooManyRequestsError(
          'Too many requests. Please slow down and try again later.',
        );
      }
    };
  }
}

/**
 * Production limiter: Redis for distributed enforcement across instances,
 * in-memory fallback so protection continues while Redis is down.
 * Behavior in environments without Redis is identical to InMemoryRateLimiter.
 */
export class CompositeRateLimiter implements RateLimiter {
  private readonly primary: RedisRateLimiter;
  private readonly fallback: InMemoryRateLimiter;

  constructor(
    private readonly redisService: RedisService,
    options?: Partial<RateLimiterOptions>,
    clientOverride?: CacheClient | undefined,
    keyPrefix = 'rl',
  ) {
    this.primary = new RedisRateLimiter(redisService, options, clientOverride, keyPrefix);
    this.fallback = new InMemoryRateLimiter(options);
  }

  async check(key: string): Promise<boolean> {
    if (this.redisService.isAvailable()) {
      return this.primary.check(key);
    }
    return this.fallback.check(key);
  }

  middleware() {
    return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      const allowed = await this.check(requestKey(request));
      if (!allowed) {
        throw new TooManyRequestsError(
          'Too many requests. Please slow down and try again later.',
        );
      }
    };
  }
}
