import { describe, it, expect } from 'vitest';
import { InMemoryRateLimiter, TooManyRequestsError } from '../src/http/rate-limiter.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

describe('In-Memory Authentication Rate Limiter', () => {
  it('allows requests within the configured threshold', () => {
    const limiter = new InMemoryRateLimiter({ windowMs: 10_000, maxRequests: 3 });
    const key = '127.0.0.1:/auth/login';

    expect(limiter.check(key)).toBe(true);
    expect(limiter.check(key)).toBe(true);
    expect(limiter.check(key)).toBe(true);
  });

  it('rejects requests exceeding the configured threshold with 429', async () => {
    const limiter = new InMemoryRateLimiter({ windowMs: 10_000, maxRequests: 2 });
    const middleware = limiter.middleware();

    const fakeReq = { ip: '192.168.1.1', routerPath: '/auth/login' } as unknown as FastifyRequest;
    const fakeReply = {} as FastifyReply;

    await expect(middleware(fakeReq, fakeReply)).resolves.toBeUndefined();
    await expect(middleware(fakeReq, fakeReply)).resolves.toBeUndefined();

    // 3rd attempt exceeds threshold
    await expect(middleware(fakeReq, fakeReply)).rejects.toThrow(TooManyRequestsError);
  });

  it('tracks different IP addresses separately', () => {
    const limiter = new InMemoryRateLimiter({ windowMs: 10_000, maxRequests: 1 });

    expect(limiter.check('ip-1:/auth/login')).toBe(true);
    expect(limiter.check('ip-1:/auth/login')).toBe(false);

    // ip-2 should still be allowed
    expect(limiter.check('ip-2:/auth/login')).toBe(true);
  });
});
