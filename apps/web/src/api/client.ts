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

export async function apiClient<T>(
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
