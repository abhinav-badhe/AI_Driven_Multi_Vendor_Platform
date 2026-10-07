import { describe, it, expect } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  CompositeRateLimiter,
  RedisRateLimiter,
  TooManyRequestsError,
} from '../src/http/rate-limiter.js';
import { InMemoryCacheClient, type CacheClient } from '../src/infra/redis/cache.js';
import type { RedisService } from '../src/infra/redis/index.js';

function stubRedisService(available: boolean): RedisService {
  return {
    isConfigured: true,
    assertUsageAllowed: () => {},
    checkHealth: async () => ({ status: available ? 'healthy' : 'unhealthy' }),
    getClient: () => null,
    isAvailable: () => available,
    shutdown: async () => {},
  };
}

describe('RedisRateLimiter', () => {
  it('allows requests within the threshold and rejects past it', async () => {
    const limiter = new RedisRateLimiter(stubRedisService(true), {
      windowMs: 60_000,
      maxRequests: 2,
    }, new InMemoryCacheClient());

    expect(await limiter.check('ip-1:/auth/login')).toBe(true);
    expect(await limiter.check('ip-1:/auth/login')).toBe(true);
    expect(await limiter.check('ip-1:/auth/login')).toBe(false);
  });

  it('tracks keys independently', async () => {
    const limiter = new RedisRateLimiter(stubRedisService(true), {
      windowMs: 60_000,
      maxRequests: 1,
    }, new InMemoryCacheClient());

    expect(await limiter.check('a')).toBe(true);
    expect(await limiter.check('a')).toBe(false);
    expect(await limiter.check('b')).toBe(true);
  });

  it('fails open when Redis errors', async () => {
    const broken: CacheClient = {
      get: async () => null,
      setEx: async () => {},
      setNxEx: async () => {
        throw new Error('redis down');
      },
      del: async () => 0,
      incr: async () => {
        throw new Error('redis down');
      },
      sadd: async () => 0,
      smembers: async () => [],
      expire: async () => 0,
    };
    const limiter = new RedisRateLimiter(stubRedisService(true), {
      windowMs: 60_000,
      maxRequests: 1,
    }, broken);

    // Must never 500 the request because the cache is down.
    expect(await limiter.check('any')).toBe(true);
    expect(await limiter.check('any')).toBe(true);
  });

  it('middleware rejects over-limit requests with 429', async () => {
    const limiter = new RedisRateLimiter(stubRedisService(true), {
      windowMs: 60_000,
      maxRequests: 1,
    }, new InMemoryCacheClient());
    const middleware = limiter.middleware();
    const fakeReq = { ip: '10.0.0.1', routerPath: '/auth/login' } as unknown as FastifyRequest;
    const fakeReply = {} as FastifyReply;

    await expect(middleware(fakeReq, fakeReply)).resolves.toBeUndefined();
    await expect(middleware(fakeReq, fakeReply)).rejects.toThrow(TooManyRequestsError);
  });
});

describe('CompositeRateLimiter', () => {
  it('uses in-memory enforcement when Redis is unavailable', async () => {
    const limiter = new CompositeRateLimiter(stubRedisService(false), {
      windowMs: 60_000,
      maxRequests: 1,
    });

    expect(await limiter.check('k')).toBe(true);
    expect(await limiter.check('k')).toBe(false);
  });

  it('uses Redis enforcement when Redis is available', async () => {
    const limiter = new CompositeRateLimiter(
      stubRedisService(true),
      { windowMs: 60_000, maxRequests: 1 },
      new InMemoryCacheClient(),
    );

    expect(await limiter.check('k')).toBe(true);
    expect(await limiter.check('k')).toBe(false);
  });
});
