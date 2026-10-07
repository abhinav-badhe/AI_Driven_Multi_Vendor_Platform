export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

let accessToken: string | null = null;
let tenantId: string | null = null;

export const setAuthData = (token: string | null, tenant: string | null) => {
  // Identity change (login/logout/tenant switch) retires every cached view
  // so one user's data can never render for another. Silent token refreshes
  // keep the same tenant and preserve the cache.
  if (tenant !== tenantId || token === null) {
    clearClientCache();
  }
  accessToken = token;
  tenantId = tenant;
};

export const getAuthToken = () => accessToken;
export const getTenantId = () => tenantId;

let onAuthFailure: (() => void) | null = null;
export const setAuthFailureHandler = (handler: () => void) => {
  onAuthFailure = handler;
};

let refreshPromise: Promise<string | null> | null = null;

// ---------------------------------------------------------------------------
// Lightweight SWR response cache (GET only, whitelisted paths).
// The backend Redis cache is the shared layer; this is the per-tab layer that
// removes the remaining network round trip for repeat views, back
// navigation, and hover prefetches. Live-state paths (cart, checkout,
// orders, payments, auth, tracking) are NEVER cached here.
// ---------------------------------------------------------------------------

interface ClientCacheEntry {
  data: unknown;
  storedAt: number;
  ttlMs: number;
  staleMs: number;
}

interface GetCacheRule {
  prefix: string;
  ttlMs: number;
  staleMs: number;
}

// Longest-prefix match wins — more specific paths must come first.
const GET_CACHE_RULES: GetCacheRule[] = [
  { prefix: '/inventory/availability', ttlMs: 8000, staleMs: 8000 },
  { prefix: '/listings/me', ttlMs: 20000, staleMs: 30000 },
  { prefix: '/merchants/me', ttlMs: 60000, staleMs: 60000 },
  { prefix: '/categories', ttlMs: 120000, staleMs: 300000 },
  { prefix: '/products', ttlMs: 60000, staleMs: 180000 },
  { prefix: '/skus', ttlMs: 60000, staleMs: 180000 },
  { prefix: '/search', ttlMs: 30000, staleMs: 60000 },
  { prefix: '/recommendations', ttlMs: 60000, staleMs: 120000 },
  { prefix: '/listings', ttlMs: 30000, staleMs: 60000 },
  { prefix: '/inventory', ttlMs: 20000, staleMs: 20000 },
  { prefix: '/analytics', ttlMs: 45000, staleMs: 90000 },
  { prefix: '/ml', ttlMs: 60000, staleMs: 120000 },
  { prefix: '/settlement', ttlMs: 20000, staleMs: 30000 },
];

interface WriteInvalidationRule {
  methods: string[];
  prefix: string;
  /** Path suffixes (before any query string) excluded from this rule. */
  exceptSuffixes?: string[];
  drop: string[];
}

// Only true state changes invalidate. Analytics pings such as
// POST /products/:id/views are explicitly excluded so view tracking
// never evicts catalog entries.
const WRITE_INVALIDATION_RULES: WriteInvalidationRule[] = [
  { methods: ['POST'], prefix: '/categories', drop: ['/categories'] },
  { methods: ['POST', 'PATCH'], prefix: '/products', exceptSuffixes: ['/views'], drop: ['/products', '/skus', '/search'] },
  { methods: ['PATCH', 'POST'], prefix: '/skus', drop: ['/skus', '/products', '/search'] },
  { methods: ['POST', 'PATCH'], prefix: '/listings', drop: ['/listings', '/skus', '/search'] },
  { methods: ['POST'], prefix: '/inventory', drop: ['/inventory', '/listings'] },
  { methods: ['POST', 'DELETE'], prefix: '/search', drop: ['/search'] },
  { methods: ['POST'], prefix: '/recommendations', drop: ['/recommendations'] },
  { methods: ['POST'], prefix: '/analytics', drop: ['/analytics'] },
  { methods: ['POST', 'PUT'], prefix: '/ml', drop: ['/ml'] },
  { methods: ['POST', 'PATCH'], prefix: '/merchants', drop: ['/merchants/me'] },
  { methods: ['POST'], prefix: '/settlement', drop: ['/settlement'] },
];

const responseCache = new Map<string, ClientCacheEntry>();
const inflightGets = new Map<string, Promise<unknown>>();

const basePathOf = (path: string): string => path.split('?')[0] ?? path;

const matchGetRule = (path: string): GetCacheRule | null => {
  const base = basePathOf(path);
  let best: GetCacheRule | null = null;
  for (const rule of GET_CACHE_RULES) {
    if (base.startsWith(rule.prefix) && (!best || rule.prefix.length > best.prefix.length)) {
      best = rule;
    }
  }
  return best;
};

const clientCacheKey = (path: string): string => `${tenantId ?? 'anon'}:${path}`;

const cloneCached = <T>(data: unknown): T => {
  try {
    return structuredClone(data) as T;
  } catch {
    return JSON.parse(JSON.stringify(data)) as T;
  }
};

const invalidateForMutation = (path: string, method: string): void => {
  const base = basePathOf(path);
  for (const rule of WRITE_INVALIDATION_RULES) {
    if (!rule.methods.includes(method)) continue;
    if (!base.startsWith(rule.prefix)) continue;
    if (rule.exceptSuffixes?.some((suffix) => base.endsWith(suffix))) continue;
    for (const prefix of rule.drop) {
      for (const key of [...responseCache.keys()]) {
        const keyPath = key.slice(key.indexOf(':') + 1);
        if (basePathOf(keyPath).startsWith(prefix)) {
          responseCache.delete(key);
        }
      }
    }
  }
};

export const clearClientCache = (): void => {
  responseCache.clear();
};

/** Test hook: drops cached entries AND in-flight deduplication state. */
export const __resetClientCacheForTests = (): void => {
  responseCache.clear();
  inflightGets.clear();
};

export const invalidateClientCache = (prefixes: string[]): void => {
  for (const key of [...responseCache.keys()]) {
    const keyPath = key.slice(key.indexOf(':') + 1);
    if (prefixes.some((prefix) => basePathOf(keyPath).startsWith(prefix))) {
      responseCache.delete(key);
    }
  }
};

/** Warm the cache for a likely-next navigation (hover/intent prefetch). */
export const prefetch = (path: string): void => {
  const rule = matchGetRule(path);
  if (!rule) return;
  const key = clientCacheKey(path);
  const entry = responseCache.get(key);
  if (entry && Date.now() - entry.storedAt < entry.ttlMs + entry.staleMs) return;
  void fetchAndStore<unknown>(key, path, {}, rule).catch(() => {});
};

function fetchAndStore<T>(
  key: string,
  path: string,
  options: RequestInit,
  rule: GetCacheRule,
): Promise<T> {
  const existing = inflightGets.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const pending = rawRequest<T>(path, options).then(
    (data) => {
      responseCache.set(key, {
        data,
        storedAt: Date.now(),
        ttlMs: rule.ttlMs,
        staleMs: rule.staleMs,
      });
      inflightGets.delete(key);
      // Clone so no caller can mutate the cached entry through its handle.
      return cloneCached<T>(data);
    },
    (err: unknown) => {
      inflightGets.delete(key);
      throw err;
    },
  );
  inflightGets.set(key, pending);
  return pending;
}

async function cachedGet<T>(path: string, options: RequestInit, rule: GetCacheRule): Promise<T> {
  const key = clientCacheKey(path);
  const entry = responseCache.get(key);
  if (entry) {
    const age = Date.now() - entry.storedAt;
    if (age < entry.ttlMs) {
      return cloneCached<T>(entry.data);
    }
    if (age < entry.ttlMs + entry.staleMs) {
      void fetchAndStore<T>(key, path, options, rule).catch(() => {});
      return cloneCached<T>(entry.data);
    }
    responseCache.delete(key);
  }
  return fetchAndStore<T>(key, path, options, rule);
}

export async function apiClient<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  if (method === 'GET') {
    const rule = matchGetRule(path);
    if (rule) {
      return cachedGet<T>(path, options, rule);
    }
  }
  const data = await rawRequest<T>(path, options);
  if (method !== 'GET') {
    invalidateForMutation(path, method);
  }
  return data;
}

async function rawRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  let response = await fetch(`/api${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (!response.ok) {
    // 401 retry logic
    if (response.status === 401 && path !== '/auth/refresh' && path !== '/auth/login' && path !== '/auth/register' && path !== '/auth/logout') {
      if (!refreshPromise) {
        refreshPromise = (async () => {
          try {
            const res = await fetch('/api/auth/refresh', {
              method: 'POST',
              credentials: 'include',
            });
            if (res.ok) {
              const data = await res.json();
              setAuthData(data.accessToken, tenantId); // We assume tenantId remains same across refresh in memory
              return data.accessToken as string;
            } else {
              throw new Error('Refresh failed');
            }
          } catch {
            setAuthData(null, null);
            if (onAuthFailure) onAuthFailure();
            return null;
          } finally {
            refreshPromise = null;
          }
        })();
      }

      const newToken = await refreshPromise;
      if (newToken) {
        const retryHeaders = new Headers(options.headers);
        retryHeaders.set('Content-Type', 'application/json');
        retryHeaders.set('Authorization', `Bearer ${newToken}`);
        
        const retryRes = await fetch(`/api${path}`, {
          ...options,
          headers: retryHeaders,
          credentials: 'include',
        });
        
        if (retryRes.ok) {
          if (retryRes.status === 204) return {} as T;
          return retryRes.json();
        }
        response = retryRes; // Fall through to standard error handling with the retry response
      }
    }

    let errorData: { error?: { message?: string; code?: string; details?: unknown } } = {};
    try {
      errorData = await response.json();
    } catch {
      // Ignore
    }
    const message = errorData?.error?.message || response.statusText || 'Unknown Error';
    const code = errorData?.error?.code || 'UNKNOWN_ERROR';
    const details = errorData?.error?.details;
    throw new ApiError(response.status, code, message, details);
  }

  // Handle empty responses
  if (response.status === 204) {
    return {} as T;
  }

  return response.json();
}
