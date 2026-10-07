import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { withTimeout, type RedisService } from './index.js';

/**
 * Cache-aside layer over Redis.
 *
 * Design rules (aligned with the architecture baseline):
 * - PostgreSQL is the source of truth. Every method here FAILS OPEN:
 *   any Redis error degrades to a direct loader/DB call, never to a 500.
 * - Cache operations are time-boxed (CACHE_OP_TIMEOUT_MS) so a slow
 *   Redis can never add user-visible latency to a request.
 * - Entries carry tags; writers invalidate by tag so reads stay fresh
 *   without depending on TTL expiry alone.
 */

export const CACHE_KEY_PREFIX = 'cx:v1';
/** Hard ceiling so a degraded Redis never delays a request. */
export const CACHE_OP_TIMEOUT_MS = 250;

/** Narrow client surface so unit tests can substitute an in-memory stub. */
export interface CacheClient {
  get(key: string): Promise<string | null>;
  setEx(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Returns true when the lock was acquired. */
  setNxEx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<number>;
}

class IoredisCacheAdapter implements CacheClient {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async setEx(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', Math.max(1, Math.floor(ttlSeconds)));
  }

  async setNxEx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const res = await this.redis.set(
      key,
      value,
      'EX',
      Math.max(1, Math.floor(ttlSeconds)),
      'NX',
    );
    return res === 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.redis.del(...keys);
  }

  async incr(key: string): Promise<number> {
    return this.redis.incr(key);
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return this.redis.sadd(key, ...members);
  }

  async smembers(key: string): Promise<string[]> {
    return this.redis.smembers(key);
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.redis.expire(key, Math.max(1, Math.floor(seconds)));
  }
}

/** In-memory CacheClient for unit tests (no Redis server required). */
export class InMemoryCacheClient implements CacheClient {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  private readonly sets = new Map<string, { members: Set<string>; expiresAt: number }>();
  private readonly counters = new Map<string, number>();

  private isLive(expiresAt: number): boolean {
    return expiresAt > Date.now();
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry || !this.isLive(entry.expiresAt)) {
      if (entry) this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async setEx(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + Math.max(1, Math.floor(ttlSeconds)) * 1000,
    });
  }

  async setNxEx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const existing = this.store.get(key);
    if (existing && this.isLive(existing.expiresAt)) return false;
    await this.setEx(key, value, ttlSeconds);
    return true;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.store.delete(key)) removed += 1;
      if (this.sets.delete(key)) removed += 1;
      if (this.counters.delete(key)) removed += 1;
    }
    return removed;
  }

  async incr(key: string): Promise<number> {
    const current = this.counters.get(key) ?? 0;
    const next = current + 1;
    this.counters.set(key, next);
    return next;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    let entry = this.sets.get(key);
    if (!entry || !this.isLive(entry.expiresAt)) {
      entry = { members: new Set(), expiresAt: Date.now() + 3600_000 };
      this.sets.set(key, entry);
    }
    let added = 0;
    for (const member of members) {
      if (!entry.members.has(member)) {
        entry.members.add(member);
        added += 1;
      }
    }
    return added;
  }

  async smembers(key: string): Promise<string[]> {
    const entry = this.sets.get(key);
    if (!entry || !this.isLive(entry.expiresAt)) {
      if (entry) this.sets.delete(key);
      return [];
    }
    return [...entry.members];
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.store.get(key) ?? this.sets.get(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + Math.max(1, Math.floor(seconds)) * 1000;
    return 1;
  }
}

export interface CacheAsideOptions {
  /** Freshness window in seconds — served directly from cache. */
  ttlSeconds: number;
  /**
   * Extra stale-while-revalidate window in seconds. Stale hits return
   * instantly while a background refresh updates the entry, so hot
   * reads never block on a recompute.
   */
  staleSeconds?: number | undefined;
  /** Tags registered on the entry for group invalidation. */
  tags?: string[] | undefined;
}

export interface CacheResult<T> {
  value: T;
  hit: boolean;
  stale: boolean;
}

interface Envelope {
  d: unknown;
  t: number;
}

function tagKey(tag: string): string {
  return `${CACHE_KEY_PREFIX}:tag:${tag}`;
}

function refreshLockKey(key: string): string {
  return `${key}:refresh`;
}

/**
 * Builds a bounded, collision-safe cache key. Long keys are hashed so
 * Redis key length stays small and keyspace scans stay cheap.
 */
export function buildCacheKey(...parts: Array<string | number>): string {
  const raw = parts.map((p) => String(p)).join(':');
  if (raw.length <= 180) return `${CACHE_KEY_PREFIX}:${raw}`;
  const digest = createHash('sha1').update(raw).digest('hex');
  return `${CACHE_KEY_PREFIX}:h:${digest}`;
}

/**
 * Resolves the narrow cache client from a RedisService.
 * Returns null when Redis is unreachable so callers fail open.
 */
export function resolveCacheClient(
  redisService: RedisService,
  override?: CacheClient | undefined,
): CacheClient | null {
  if (override) return override;
  const redis = redisService.getClient();
  if (!redis) return null;
  return new IoredisCacheAdapter(redis);
}

export class CacheService {
  constructor(
    private readonly redisService: RedisService,
    private readonly clientOverride?: CacheClient | undefined,
  ) {
    this.redisService.assertUsageAllowed('cache');
  }

  private resolveClient(): CacheClient | null {
    return resolveCacheClient(this.redisService, this.clientOverride);
  }

  /**
   * Cache-aside read with optional stale-while-revalidate.
   * Never throws for cache reasons — falls back to `loader`.
   */
  async getOrLoad<T>(
    key: string,
    options: CacheAsideOptions,
    loader: () => Promise<T>,
  ): Promise<CacheResult<T>> {
    const client = this.resolveClient();
    if (!client) {
      return { value: await loader(), hit: false, stale: false };
    }

    const staleWindow = Math.max(0, Math.floor(options.staleSeconds ?? 0));
    const now = Date.now();

    try {
      const raw = await withTimeout(client.get(key), CACHE_OP_TIMEOUT_MS);
      if (raw !== null) {
        const envelope = JSON.parse(raw) as Envelope;
        if (envelope && typeof envelope === 'object' && 'd' in envelope && 't' in envelope) {
          const ageSec = (now - Number(envelope.t)) / 1000;
          if (ageSec < options.ttlSeconds) {
            return { value: envelope.d as T, hit: true, stale: false };
          }
          if (ageSec < options.ttlSeconds + staleWindow) {
            this.refreshInBackground(client, key, options, loader);
            return { value: envelope.d as T, hit: true, stale: true };
          }
        }
      }
    } catch {
      // Corrupt entry, slow Redis, or any cache fault → recompute below.
    }

    const value = await loader();
    await this.store(client, key, value, options);
    return { value, hit: false, stale: false };
  }

  /** Direct write-through helper for paths that already computed a value. */
  async set<T>(key: string, value: T, options: CacheAsideOptions): Promise<void> {
    const client = this.resolveClient();
    if (!client) return;
    await this.store(client, key, value, options);
  }

  async invalidateKeys(...keys: string[]): Promise<void> {
    const client = this.resolveClient();
    if (!client || keys.length === 0) return;
    try {
      await withTimeout(client.del(...keys), CACHE_OP_TIMEOUT_MS);
    } catch {
      // Invalidation is best-effort; TTL expiry remains the backstop.
    }
  }

  /** Invalidates every entry registered under the given tags. */
  async invalidateTags(...tags: string[]): Promise<void> {
    const client = this.resolveClient();
    if (!client || tags.length === 0) return;
    try {
      await withTimeout(
        (async () => {
          for (const tag of tags) {
            const members = await client.smembers(tagKey(tag));
            if (members.length > 0) {
              await client.del(...members);
            }
            await client.del(tagKey(tag));
          }
        })(),
        CACHE_OP_TIMEOUT_MS * 4,
      );
    } catch {
      // Best-effort; TTL expiry remains the backstop.
    }
  }

  private refreshInBackground<T>(
    client: CacheClient,
    key: string,
    options: CacheAsideOptions,
    loader: () => Promise<T>,
  ): void {
    void (async () => {
      try {
        const acquired = await withTimeout(
          client.setNxEx(refreshLockKey(key), '1', 30),
          CACHE_OP_TIMEOUT_MS,
        );
        if (!acquired) return; // Another worker is already refreshing.
        const value = await loader();
        await this.store(client, key, value, options);
      } catch {
        // Background refresh must never surface errors to the request.
      }
    })();
  }

  private async store<T>(
    client: CacheClient,
    key: string,
    value: T,
    options: CacheAsideOptions,
  ): Promise<void> {
    try {
      const staleWindow = Math.max(0, Math.floor(options.staleSeconds ?? 0));
      const ttl = Math.max(1, Math.floor(options.ttlSeconds + staleWindow));
      const envelope: Envelope = { d: value, t: Date.now() };
      await withTimeout(client.setEx(key, JSON.stringify(envelope), ttl), CACHE_OP_TIMEOUT_MS);
      const tags = options.tags ?? [];
      if (tags.length > 0) {
        await withTimeout(
          (async () => {
            for (const tag of tags) {
              await client.sadd(tagKey(tag), key);
              await client.expire(tagKey(tag), ttl + 60);
            }
          })(),
          CACHE_OP_TIMEOUT_MS * 2,
        );
      }
    } catch {
      // Cache write failures are invisible to callers.
    }
  }
}
