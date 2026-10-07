import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildCacheKey, type CacheAsideOptions } from '../infra/redis/cache.js';
import { CacheGroups } from '../infra/redis/cache-keys.js';

export { CacheGroups as CacheTags };
export {
  categoryTag,
  productTag,
  skuTag,
  listingTag,
  listingMerchantTag,
  listingSkuTag,
  inventoryListingTag,
  inventoryItemTag,
  inventoryMerchantTag,
} from '../infra/redis/cache-keys.js';

/**
 * Shared HTTP caching conventions.
 *
 * - Keys always embed a visibility class (actor role) whenever the loader
 *   result can differ by authorization level, so privileged rows can never
 *   leak into another role's cache entry.
 * - `X-Cache: HIT | STALE | MISS` is emitted for observability.
 * - Errors thrown by loaders (404 validation etc.) propagate to the global
 *   error handler and are NEVER cached.
 */

export const CachePresets = {
  /** Reference data that changes via admin actions only. */
  categories: { ttlSeconds: 300, staleSeconds: 600 },
  /** Canonical product / SKU detail. */
  catalogDetail: { ttlSeconds: 120, staleSeconds: 300 },
  /** Filtered product collections. */
  catalogList: { ttlSeconds: 60, staleSeconds: 180 },
  reviews: { ttlSeconds: 120, staleSeconds: 300 },
  /** Merchant listings (price/status can change often). */
  listing: { ttlSeconds: 45, staleSeconds: 90 },
  /** Merchant-scoped collections (keyed per tenant). */
  merchantScoped: { ttlSeconds: 30, staleSeconds: 60 },
  /**
   * Availability is advisory only — checkout revalidates against the
   * authoritative ledger and reserves atomically, so a short window is safe.
   */
  availability: { ttlSeconds: 8, staleSeconds: 15 },
  /** Derived read model; invalidated on projection rebuilds. */
  search: { ttlSeconds: 45, staleSeconds: 120 },
  /** Expensive computed ranking; feedback loop stays on the write path. */
  recommendations: { ttlSeconds: 120, staleSeconds: 300 },
  analytics: { ttlSeconds: 60, staleSeconds: 180 },
  /** Model registry reads and stored predictions; retraining invalidates. */
  ml: { ttlSeconds: 120, staleSeconds: 300 },
  /**
   * Order/shipment tracking views. State flips often (payment, packing,
   * carrier scans), so the window is intentionally tiny — just enough to
   * absorb polling bursts and repeat visits.
   */
  orderView: { ttlSeconds: 10, staleSeconds: 20 },
} satisfies Record<string, CacheAsideOptions>;

export function visibilityClass(request: FastifyRequest): string {
  return request.actor?.role ?? 'anon';
}

export interface CachedSendOptions {
  key: string;
  tags: string[];
  preset: CacheAsideOptions;
  status?: number | undefined;
}

export function cacheKey(...parts: Array<string | number>): string {
  return buildCacheKey(...parts);
}

/**
 * Cache-aside GET helper: serves HIT/STALE instantly, computes on MISS,
 * and tags the entry for group invalidation by writers.
 */
export async function sendCached<T>(
  app: FastifyInstance,
  _request: FastifyRequest,
  reply: FastifyReply,
  options: CachedSendOptions,
  loader: () => Promise<T>,
): Promise<void> {
  const result = await app.cache.getOrLoad(
    options.key,
    {
      ttlSeconds: options.preset.ttlSeconds,
      staleSeconds: options.preset.staleSeconds,
      tags: options.tags,
    },
    loader,
  );
  reply.header('X-Cache', result.hit ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
  await reply.status(options.status ?? 200).send(result.value);
}
