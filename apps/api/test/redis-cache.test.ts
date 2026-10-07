import { describe, it, expect } from 'vitest';
import {
  CacheService,
  InMemoryCacheClient,
  buildCacheKey,
  type CacheClient,
} from '../src/infra/redis/cache.js';
import { createRedisService } from '../src/infra/redis/index.js';

function disabledRedisService() {
  return createRedisService({
    host: 'localhost',
    port: 6379,
    password: 'placeholder_redis_password',
    tls: false,
  });
}

describe('Cache key builder', () => {
  it('namespaces short keys without hashing', () => {
    expect(buildCacheKey('products', 'abc')).toBe('cx:v1:products:abc');
  });

  it('hashes long keys to keep them bounded', () => {
    const key = buildCacheKey('search', 'q', 'x'.repeat(500));
    expect(key.startsWith('cx:v1:h:')).toBe(true);
    expect(key.length).toBeLessThan(60);
  });
});

describe('CacheService with in-memory client', () => {
  it('misses, loads, then hits on the second read', async () => {
    const cache = new CacheService(disabledRedisService(), new InMemoryCacheClient());
    let loads = 0;
    const loader = async () => {
      loads += 1;
      return { id: 'p1', title: 'Widget' };
    };

    const first = await cache.getOrLoad('k1', { ttlSeconds: 60 }, loader);
    expect(first.hit).toBe(false);
    expect(first.value.title).toBe('Widget');

    const second = await cache.getOrLoad('k1', { ttlSeconds: 60 }, loader);
    expect(second.hit).toBe(true);
    expect(loads).toBe(1);
  });

  it('serves stale instantly while revalidating in the background', async () => {
    const client = new InMemoryCacheClient();
    const cache = new CacheService(disabledRedisService(), client);
    let version = 1;
    const loader = async () => ({ v: version });

    await cache.getOrLoad('swr', { ttlSeconds: 60 }, loader);
    // Force the entry to look expired-but-stale by rewriting it old.
    const raw = await client.get('swr');
    expect(raw).not.toBeNull();
    const envelope = JSON.parse(raw as string) as { d: unknown; t: number };
    envelope.t = Date.now() - 61_000;
    await client.setEx('swr', JSON.stringify(envelope), 300);

    version = 2;
    const stale = await cache.getOrLoad('swr', { ttlSeconds: 60, staleSeconds: 300 }, loader);
    expect(stale.hit).toBe(true);
    expect(stale.stale).toBe(true);
    expect((stale.value as { v: number }).v).toBe(1);

    // Background refresh should converge to version 2.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fresh = await cache.getOrLoad('swr', { ttlSeconds: 60, staleSeconds: 300 }, loader);
    expect((fresh.value as { v: number }).v).toBe(2);
  });

  it('invalidates every entry registered under a tag', async () => {
    const cache = new CacheService(disabledRedisService(), new InMemoryCacheClient());
    let loads = 0;
    const loader = async () => {
      loads += 1;
      return { n: loads };
    };

    await cache.getOrLoad('a', { ttlSeconds: 60, tags: ['products'] }, loader);
    await cache.getOrLoad('b', { ttlSeconds: 60, tags: ['products'] }, loader);
    expect(loads).toBe(2);

    await cache.invalidateTags('products');

    await cache.getOrLoad('a', { ttlSeconds: 60, tags: ['products'] }, loader);
    await cache.getOrLoad('b', { ttlSeconds: 60, tags: ['products'] }, loader);
    expect(loads).toBe(4);
  });

  it('fails open to the loader when the cache client throws', async () => {
    const broken: CacheClient = {
      get: async () => {
        throw new Error('redis down');
      },
      setEx: async () => {
        throw new Error('redis down');
      },
      setNxEx: async () => {
        throw new Error('redis down');
      },
      del: async () => {
        throw new Error('redis down');
      },
      incr: async () => {
        throw new Error('redis down');
      },
      sadd: async () => {
        throw new Error('redis down');
      },
      smembers: async () => {
        throw new Error('redis down');
      },
      expire: async () => {
        throw new Error('redis down');
      },
    };
    const cache = new CacheService(disabledRedisService(), broken);
    const result = await cache.getOrLoad('x', { ttlSeconds: 60 }, async () => 'db-value');
    expect(result.value).toBe('db-value');
    expect(result.hit).toBe(false);
    await expect(cache.invalidateTags('t')).resolves.toBeUndefined();
  });

  it('falls back to the loader when Redis is not configured', async () => {
    const cache = new CacheService(disabledRedisService());
    const result = await cache.getOrLoad('x', { ttlSeconds: 60 }, async () => 42);
    expect(result.value).toBe(42);
    expect(result.hit).toBe(false);
  });
});

describe('RedisService disabled mode', () => {
  it('reports disabled and never returns a client for placeholder config', async () => {
    const service = disabledRedisService();
    expect(service.isConfigured).toBe(false);
    expect(service.getClient()).toBeNull();
    expect(service.isAvailable()).toBe(false);
    const health = await service.checkHealth();
    expect(health.status).toBe('disabled');
    await service.shutdown();
  });

  it('rejects unapproved usage categories', () => {
    const service = disabledRedisService();
    expect(() => service.assertUsageAllowed('cache')).not.toThrow();
    expect(() =>
      service.assertUsageAllowed('transactional-truth' as never),
    ).toThrow(/Architectural violation/);
  });
});
