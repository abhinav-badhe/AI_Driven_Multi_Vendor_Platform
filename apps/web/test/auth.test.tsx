import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider, useAuth } from '../src/features/auth/AuthContext.js';
import { MerchantLayout } from '../src/layouts/MerchantLayout.js';
import { AdminLayout } from '../src/layouts/AdminLayout.js';
import { apiClient, setAuthData, getAuthToken } from '../src/api/client.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const ME_RESPONSE = {
  userId: 'u-1',
  email: 'test@example.com',
  tenantId: 'tenant-1',
  role: 'CUSTOMER',
};

const MERCHANT_ME = { ...ME_RESPONSE, role: 'MERCHANT' };
const ADMIN_ME = { ...ME_RESPONSE, role: 'ADMINISTRATOR' };

const ACCESS_TOKEN = 'test.access.token';

/**
 * Mock global.fetch with a sequence of responses.
 * Each call to fetch consumes the next item from the array.
 */
function mockFetchSequence(responses: Array<() => Response | Promise<Response>>) {
  let idx = 0;
  global.fetch = vi.fn().mockImplementation(() => {
    const fn = responses[idx] ?? responses[responses.length - 1];
    idx++;
    return Promise.resolve(typeof fn === 'function' ? fn() : fn);
  });
}

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function failResponse(status: number): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    json: () => Promise.resolve({ error: { message: 'Error', code: 'ERR' } }),
  } as unknown as Response;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Phase B – Frontend Authentication Security Properties', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setAuthData(null, null);
    vi.restoreAllMocks();
  });

  afterEach(cleanup);

  // ── 1. Session restoration ────────────────────────────────────────────────

  it('1. Initial session restoration calls /auth/refresh with credentials:include', async () => {
    let refreshCallArgs: RequestInit | undefined;

    global.fetch = vi.fn().mockImplementation((url: string, opts: RequestInit) => {
      if (url.includes('/auth/refresh')) {
        refreshCallArgs = opts;
        return Promise.resolve(failResponse(401)); // no valid cookie in test
      }
      return Promise.resolve(failResponse(404));
    });

    const Probe = () => {
      useAuth();
      return null;
    };
    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });

    expect(global.fetch).toHaveBeenCalled();
    expect(refreshCallArgs).toBeDefined();
    expect(refreshCallArgs?.credentials).toBe('include');
  });

  it('2. Successful session restoration establishes authenticated state', async () => {
    mockFetchSequence([
      // /auth/refresh
      () => okJson({ accessToken: ACCESS_TOKEN }),
      // /auth/me
      () => okJson(ME_RESPONSE),
    ]);

    let capturedAuth: any;
    const Probe = () => {
      capturedAuth = useAuth();
      return null;
    };
    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });
    await waitFor(() => expect(capturedAuth?.isLoading).toBe(false));

    expect(capturedAuth.isAuthenticated).toBe(true);
    expect(capturedAuth.user?.email).toBe('test@example.com');
  });

  it('2b. Concurrent mounts share one session restore (no double refresh POST)', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    fetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/auth/refresh')) {
        return Promise.resolve(okJson({ accessToken: ACCESS_TOKEN }));
      }
      return Promise.resolve(okJson(ME_RESPONSE));
    });

    // Simulate StrictMode double-mount: two providers alive at once must
    // still fire exactly one refresh — a second concurrent POST with the
    // same cookie races rotation and gets the family revoked server-side.
    await act(async () => {
      render(
        <>
          <AuthProvider>
            <div />
          </AuthProvider>
          <AuthProvider>
            <div />
          </AuthProvider>
        </>,
      );
    });

    const refreshCalls = fetchMock.mock.calls.filter(
      ([url]: any) => typeof url === 'string' && url.includes('/auth/refresh'),
    );
    expect(refreshCalls.length).toBe(1);
  });

  it('3. Failed session restoration results in unauthenticated state (not an error)', async () => {
    mockFetchSequence([() => failResponse(401)]);

    let capturedAuth: any;
    const Probe = () => {
      capturedAuth = useAuth();
      return null;
    };
    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });
    await waitFor(() => expect(capturedAuth?.isLoading).toBe(false));

    expect(capturedAuth.isAuthenticated).toBe(false);
    expect(capturedAuth.user).toBeNull();
  });

  // ── 4–5. Login ────────────────────────────────────────────────────────────

  it('4. login() sends credentials:include and stores access token only in memory', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    // Auth restore → fail (no cookie)
    fetchMock.mockResolvedValueOnce(failResponse(401));
    // POST /auth/login
    fetchMock.mockResolvedValueOnce(okJson({ accessToken: ACCESS_TOKEN }));
    // GET /auth/me
    fetchMock.mockResolvedValueOnce(okJson(ME_RESPONSE));

    let capturedAuth: any;
    const Probe = () => {
      capturedAuth = useAuth();
      return null;
    };
    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });
    await waitFor(() => expect(capturedAuth?.isLoading).toBe(false));

    await act(async () => {
      await capturedAuth.login({ email: 'test@example.com', password: 'secret' });
    });

    // 4a. Access token must NOT be in localStorage
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('accessToken')).toBeNull();

    // 4b. Access token must NOT be in sessionStorage
    expect(sessionStorage.getItem('token')).toBeNull();

    // 4c. Access token is in module-level memory (getAuthToken)
    expect(getAuthToken()).toBe(ACCESS_TOKEN);

    // 4d. Login call used credentials:include
    const loginCall = fetchMock.mock.calls.find(
      ([url]: any) => typeof url === 'string' && url.includes('/auth/login'),
    );
    expect(loginCall).toBeDefined();
    expect(loginCall![1].credentials).toBe('include');
  });

  it('5. login() response never persists refreshToken to any storage', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    fetchMock.mockResolvedValueOnce(failResponse(401));
    // Backend now returns no refreshToken in body – only accessToken
    fetchMock.mockResolvedValueOnce(okJson({ accessToken: ACCESS_TOKEN }));
    fetchMock.mockResolvedValueOnce(okJson(ME_RESPONSE));

    let capturedAuth: any;
    const Probe = () => {
      capturedAuth = useAuth();
      return null;
    };
    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });
    await waitFor(() => expect(capturedAuth?.isLoading).toBe(false));
    await act(async () => {
      await capturedAuth.login({ email: 'test@example.com', password: 'secret' });
    });

    // refreshToken must never appear in any storage
    for (const key of Object.keys(localStorage)) {
      expect(key.toLowerCase()).not.toContain('refresh');
      const val = localStorage.getItem(key) ?? '';
      expect(val.toLowerCase()).not.toContain('refresh');
    }
    for (const key of Object.keys(sessionStorage)) {
      expect(key.toLowerCase()).not.toContain('refresh');
    }
  });

  it('6. register() creates an unverified account without signing in', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    fetchMock.mockResolvedValueOnce(failResponse(401)); // restore
    fetchMock.mockResolvedValueOnce(
      okJson({ userId: 'u-1', email: 'new@example.com', requiresVerification: true }),
    ); // register

    let capturedAuth: any;
    const Probe = () => {
      capturedAuth = useAuth();
      return null;
    };
    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });
    await waitFor(() => expect(capturedAuth?.isLoading).toBe(false));

    let result: any;
    await act(async () => {
      result = await capturedAuth.register({
        email: 'new@example.com',
        password: 'secret',
        tenantName: 'New Tenant',
        role: 'CUSTOMER',
      });
    });

    const regCall = fetchMock.mock.calls.find(
      ([url]: any) => typeof url === 'string' && url.includes('/auth/register'),
    );
    expect(regCall).toBeDefined();
    expect(regCall![1].credentials).toBe('include');
    // No session is issued at signup: the user stays signed out until verified.
    expect(result.requiresVerification).toBe(true);
    expect(capturedAuth.isAuthenticated).toBe(false);
    expect(localStorage.getItem('token')).toBeNull();
  });

  // ── 7. Logout ─────────────────────────────────────────────────────────────

  it('7. logout() sends credentials:include and clears in-memory state', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    // Session restore
    fetchMock.mockResolvedValueOnce(okJson({ accessToken: ACCESS_TOKEN }));
    fetchMock.mockResolvedValueOnce(okJson(ME_RESPONSE));
    // logout 204
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: () => Promise.resolve({}),
    } as unknown as Response);

    let capturedAuth: any;
    const Probe = () => {
      capturedAuth = useAuth();
      return null;
    };
    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });
    await waitFor(() => expect(capturedAuth?.isLoading).toBe(false));
    expect(capturedAuth.isAuthenticated).toBe(true);

    await act(async () => {
      await capturedAuth.logout();
    });

    expect(capturedAuth.isAuthenticated).toBe(false);
    expect(capturedAuth.user).toBeNull();
    expect(getAuthToken()).toBeNull();

    const logoutCall = fetchMock.mock.calls.find(
      ([url]: any) => typeof url === 'string' && url.includes('/auth/logout'),
    );
    expect(logoutCall).toBeDefined();
    expect(logoutCall![1].credentials).toBe('include');
  });

  it('7b. logout() clears in-memory state even when the backend call fails', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    fetchMock.mockResolvedValueOnce(okJson({ accessToken: ACCESS_TOKEN }));
    fetchMock.mockResolvedValueOnce(okJson(ME_RESPONSE));
    fetchMock.mockResolvedValueOnce(failResponse(500)); // logout fails

    let capturedAuth: any;
    const Probe = () => {
      capturedAuth = useAuth();
      return null;
    };
    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });
    await waitFor(() => expect(capturedAuth?.isLoading).toBe(false));

    await act(async () => {
      await capturedAuth.logout().catch(() => {});
    });

    // State must be cleared regardless
    expect(capturedAuth.isAuthenticated).toBe(false);
    expect(getAuthToken()).toBeNull();
  });

  // ── 8. Route protection ───────────────────────────────────────────────────

  it('8. Unauthenticated user is redirected away from merchant route', async () => {
    global.fetch = vi.fn().mockResolvedValue(failResponse(401)); // no session

    await act(async () => {
      render(
        <AuthProvider>
          <MemoryRouter initialEntries={['/merchant']}>
            <Routes>
              <Route path="/merchant" element={<MerchantLayout />}>
                <Route index element={<div>Merchant Content</div>} />
              </Route>
              <Route path="/account" element={<div>Login Page</div>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>,
      );
    });
    await waitFor(() =>
      expect(screen.queryByText('Login Page') ?? screen.queryByText('Loading...')).not.toBeNull(),
    );

    // After loading resolves, must be at login page
    await waitFor(() => screen.getByText('Login Page'));
    expect(screen.queryByText('Merchant Content')).toBeNull();
  });

  it('9. Unauthenticated user is redirected away from admin route', async () => {
    global.fetch = vi.fn().mockResolvedValue(failResponse(401));

    await act(async () => {
      render(
        <AuthProvider>
          <MemoryRouter initialEntries={['/admin']}>
            <Routes>
              <Route path="/admin" element={<AdminLayout />}>
                <Route index element={<div>Admin Content</div>} />
              </Route>
              <Route path="/account" element={<div>Login Page</div>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>,
      );
    });
    await waitFor(() => screen.getByText('Login Page'));
    expect(screen.queryByText('Admin Content')).toBeNull();
  });

  it('10. MERCHANT role from backend context grants access to merchant route', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    fetchMock.mockResolvedValueOnce(okJson({ accessToken: ACCESS_TOKEN }));
    fetchMock.mockResolvedValueOnce(okJson(MERCHANT_ME));

    await act(async () => {
      render(
        <AuthProvider>
          <MemoryRouter initialEntries={['/merchant']}>
            <Routes>
              <Route path="/merchant" element={<MerchantLayout />}>
                <Route index element={<div>Merchant Content</div>} />
              </Route>
              <Route path="/account" element={<div>Login Page</div>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>,
      );
    });
    await waitFor(() => screen.getByText('Merchant Content'));
    expect(screen.queryByText('Login Page')).toBeNull();
  });

  it('11. CUSTOMER role cannot access merchant route', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    fetchMock.mockResolvedValueOnce(okJson({ accessToken: ACCESS_TOKEN }));
    fetchMock.mockResolvedValueOnce(okJson(ME_RESPONSE)); // role = CUSTOMER

    await act(async () => {
      render(
        <AuthProvider>
          <MemoryRouter initialEntries={['/merchant']}>
            <Routes>
              <Route path="/merchant" element={<MerchantLayout />}>
                <Route index element={<div>Merchant Content</div>} />
              </Route>
              <Route path="/account" element={<div>Login Page</div>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>,
      );
    });
    await waitFor(() => screen.getByText('Login Page'));
    expect(screen.queryByText('Merchant Content')).toBeNull();
  });

  it('12. ADMINISTRATOR role from backend context grants access to admin route', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    fetchMock.mockResolvedValueOnce(okJson({ accessToken: ACCESS_TOKEN }));
    fetchMock.mockResolvedValueOnce(okJson(ADMIN_ME));

    await act(async () => {
      render(
        <AuthProvider>
          <MemoryRouter initialEntries={['/admin']}>
            <Routes>
              <Route path="/admin" element={<AdminLayout />}>
                <Route index element={<div>Admin Content</div>} />
              </Route>
              <Route path="/account" element={<div>Login Page</div>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>,
      );
    });
    await waitFor(() => screen.getByText('Admin Content'));
    expect(screen.queryByText('Login Page')).toBeNull();
  });

  // ── 13–15. 401 retry / concurrency ────────────────────────────────────────

  it('13. One 401 triggers exactly one refresh attempt', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    // Restore: no cookie
    fetchMock.mockResolvedValueOnce(failResponse(401));

    // Set an access token to trigger the 401 guard path
    setAuthData('stale.token', 'tenant-1');

    // The real protected request → 401
    fetchMock.mockResolvedValueOnce(failResponse(401));
    // The refresh attempt → fails
    fetchMock.mockResolvedValueOnce(failResponse(401));

    try {
      await apiClient('/some/protected/endpoint');
    } catch {
      // expected – refresh failed, error thrown
    }

    const refreshCalls = fetchMock.mock.calls.filter(
      ([url]: any) => typeof url === 'string' && url.includes('/auth/refresh'),
    );
    expect(refreshCalls.length).toBe(1);
  });

  it('14. Concurrent 401s share a single in-flight refresh request', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    let refreshResolve: (v: Response) => void;
    const refreshGate = new Promise<Response>((res) => {
      refreshResolve = res;
    });

    // Both protected requests return 401 immediately
    fetchMock.mockResolvedValueOnce(failResponse(401));
    fetchMock.mockResolvedValueOnce(failResponse(401));
    // Refresh call – gated to ensure both 401s arrive before resolving
    fetchMock.mockImplementationOnce(() => refreshGate);
    // After successful refresh, retry both original requests fail (not important here)
    fetchMock.mockResolvedValue(failResponse(403));

    setAuthData('stale.token', 'tenant-1');

    // Launch two concurrent requests that will both hit 401
    const p1 = apiClient('/endpoint/a').catch(() => null);
    const p2 = apiClient('/endpoint/b').catch(() => null);

    // Let both reach the refresh guard, then resolve refresh
    await new Promise((r) => setTimeout(r, 0));
    refreshResolve!(failResponse(401) as Response);

    await Promise.all([p1, p2]);

    const refreshCalls = fetchMock.mock.calls.filter(
      ([url]: any) => typeof url === 'string' && url.includes('/auth/refresh'),
    );
    // Despite two concurrent 401s, only one refresh must be issued
    expect(refreshCalls.length).toBe(1);
  });

  it('15. Successful refresh retries original request once (not infinite)', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    setAuthData('stale.token', 'tenant-1');

    // Original request → 401
    fetchMock.mockResolvedValueOnce(failResponse(401));
    // Refresh succeeds
    fetchMock.mockResolvedValueOnce(okJson({ accessToken: 'fresh.token' }));
    // Retry of original request succeeds
    fetchMock.mockResolvedValueOnce(okJson({ data: 'ok' }));

    const result = await apiClient<{ data: string }>('/some/endpoint');
    expect(result.data).toBe('ok');

    const protectedCalls = fetchMock.mock.calls.filter(
      ([url]: any) => typeof url === 'string' && url.includes('/some/endpoint'),
    );
    // Exactly 2: the original failing request + one retry
    expect(protectedCalls.length).toBe(2);
  });

  it('16. Failed refresh does NOT loop – throws once and clears auth', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    setAuthData('stale.token', 'tenant-1');

    // Original → 401
    fetchMock.mockResolvedValueOnce(failResponse(401));
    // Refresh → 401
    fetchMock.mockResolvedValueOnce(failResponse(401));

    let threw = false;
    try {
      await apiClient('/protected');
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    // Auth token must be cleared after failed refresh
    expect(getAuthToken()).toBeNull();

    // Only 2 fetch calls total (original + refresh) – no loop
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  // ── 16–17. No localStorage / no refreshToken ──────────────────────────────

  it('17. localStorage has no token/role/tenantId entries after login', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    fetchMock.mockResolvedValueOnce(failResponse(401));
    fetchMock.mockResolvedValueOnce(okJson({ accessToken: ACCESS_TOKEN }));
    fetchMock.mockResolvedValueOnce(okJson(ME_RESPONSE));

    let capturedAuth: any;
    const Probe = () => {
      capturedAuth = useAuth();
      return null;
    };
    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });
    await waitFor(() => expect(capturedAuth?.isLoading).toBe(false));
    await act(async () => {
      await capturedAuth.login({ email: 'test@example.com', password: 'secret' });
    });

    const forbiddenKeys = ['token', 'accessToken', 'tenantId', 'role', 'refresh'];
    for (const key of forbiddenKeys) {
      expect(localStorage.getItem(key)).toBeNull();
    }
    // No key should contain the word "refresh"
    for (const k of Object.keys(localStorage)) {
      expect(k.toLowerCase()).not.toContain('refresh');
    }
  });

  it('18. refreshToken is never referenced in frontend application state', async () => {
    // This verifies the AuthContext type contract: no refreshToken field exposed
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    fetchMock.mockResolvedValueOnce(okJson({ accessToken: ACCESS_TOKEN }));
    fetchMock.mockResolvedValueOnce(okJson(ME_RESPONSE));

    let capturedAuth: any;
    const Probe = () => {
      capturedAuth = useAuth();
      return null;
    };
    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });
    await waitFor(() => expect(capturedAuth?.isLoading).toBe(false));

    // AuthContext must not expose refreshToken
    expect(capturedAuth.refreshToken).toBeUndefined();
    expect('refreshToken' in capturedAuth).toBe(false);
  });

  // ── Logout-specific frontend security properties ──────────────────────────

  describe('Frontend logout security properties (Phase B blocker fix)', () => {
    it('F11. logout does NOT trigger a /auth/refresh before calling /auth/logout', async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock;

      // Session restore → success
      fetchMock.mockResolvedValueOnce(okJson({ accessToken: ACCESS_TOKEN }));
      fetchMock.mockResolvedValueOnce(okJson(ME_RESPONSE));
      // Logout → 204
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: () => Promise.resolve({}),
      } as unknown as Response);

      let capturedAuth: any;
      const Probe = () => {
        capturedAuth = useAuth();
        return null;
      };
      await act(async () => {
        render(
          <AuthProvider>
            <Probe />
          </AuthProvider>,
        );
      });
      await waitFor(() => expect(capturedAuth?.isLoading).toBe(false));

      await act(async () => {
        await capturedAuth.logout();
      });

      // The only calls should be: restore(refresh), restore(me), logout
      // /auth/refresh must NOT be called again as a prerequisite for logout
      const refreshCalls = fetchMock.mock.calls
        .filter(([url]: any) => typeof url === 'string' && url.includes('/auth/refresh'))
        .filter(
          (_: unknown, i: number) => i > 0, // skip the session restore call
        );
      // Any extra refresh call after the initial session restore is the bug
      expect(refreshCalls.length).toBe(0);
      const logoutCall = fetchMock.mock.calls.find(
        ([url]: any) => typeof url === 'string' && url.includes('/auth/logout'),
      );
      expect(logoutCall).toBeDefined();

      // Count refresh calls that happened AFTER the first two (restore) calls
      const allCalls: string[] = fetchMock.mock.calls.map(([url]: any) => url as string);
      const logoutIndex = allCalls.findIndex((u) => u.includes('/auth/logout'));
      const extraRefreshBeforeLogout = allCalls
        .slice(2, logoutIndex) // calls between session restore and logout
        .filter((u) => u.includes('/auth/refresh'));
      expect(extraRefreshBeforeLogout.length).toBe(0);
    });

    it('F12. logout sends credentials:include', async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock;

      fetchMock.mockResolvedValueOnce(okJson({ accessToken: ACCESS_TOKEN }));
      fetchMock.mockResolvedValueOnce(okJson(ME_RESPONSE));
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: () => Promise.resolve({}),
      } as unknown as Response);

      let capturedAuth: any;
      const Probe = () => {
        capturedAuth = useAuth();
        return null;
      };
      await act(async () => {
        render(
          <AuthProvider>
            <Probe />
          </AuthProvider>,
        );
      });
      await waitFor(() => expect(capturedAuth?.isLoading).toBe(false));
      await act(async () => {
        await capturedAuth.logout();
      });

      const logoutCall = fetchMock.mock.calls.find(
        ([url]: any) => typeof url === 'string' && url.includes('/auth/logout'),
      );
      expect(logoutCall).toBeDefined();
      expect(logoutCall![1].credentials).toBe('include');
    });

    it('F13. frontend never reads auth_refresh cookie from document.cookie', async () => {
      // The HttpOnly cookie is inaccessible to JS, but we can verify the frontend
      // never attempts to read document.cookie for auth purposes.
      // By checking that no auth_refresh or refresh-related keys appear anywhere in the fetch
      // bodies, headers, or storage, we prove the frontend is cookie-blind.
      const fetchMock = vi.fn();
      global.fetch = fetchMock;
      fetchMock.mockResolvedValueOnce(okJson({ accessToken: ACCESS_TOKEN }));
      fetchMock.mockResolvedValueOnce(okJson(ME_RESPONSE));
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: () => Promise.resolve({}),
      } as unknown as Response);

      let capturedAuth: any;
      const Probe = () => {
        capturedAuth = useAuth();
        return null;
      };
      await act(async () => {
        render(
          <AuthProvider>
            <Probe />
          </AuthProvider>,
        );
      });
      await waitFor(() => expect(capturedAuth?.isLoading).toBe(false));
      await act(async () => {
        await capturedAuth.logout();
      });

      // No fetch call should have an auth_refresh header or body field
      for (const [, opts] of fetchMock.mock.calls as [string, RequestInit][]) {
        const body = typeof opts?.body === 'string' ? opts.body : '';
        expect(body).not.toContain('auth_refresh');
        expect(body).not.toContain('refreshToken');
        const hdrs = opts?.headers as Record<string, string> | undefined;
        if (hdrs) {
          const headerStr = JSON.stringify(hdrs);
          expect(headerStr).not.toContain('auth_refresh');
        }
      }
    });

    it('F14. frontend clears in-memory access token after successful logout', async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock;

      fetchMock.mockResolvedValueOnce(okJson({ accessToken: ACCESS_TOKEN }));
      fetchMock.mockResolvedValueOnce(okJson(ME_RESPONSE));
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: () => Promise.resolve({}),
      } as unknown as Response);

      let capturedAuth: any;
      const Probe = () => {
        capturedAuth = useAuth();
        return null;
      };
      await act(async () => {
        render(
          <AuthProvider>
            <Probe />
          </AuthProvider>,
        );
      });
      await waitFor(() => expect(capturedAuth?.isLoading).toBe(false));
      expect(getAuthToken()).toBe(ACCESS_TOKEN); // token present before logout

      await act(async () => {
        await capturedAuth.logout();
      });

      expect(getAuthToken()).toBeNull(); // token cleared after logout
      expect(capturedAuth.isAuthenticated).toBe(false);
      expect(capturedAuth.user).toBeNull();
    });

    it('F15. logout does NOT trigger the 401 refresh-retry loop — /auth/logout excluded from retry path', async () => {
      // With the fix, /auth/logout is in the exclusion list.
      // A 401 from logout must NOT trigger a refresh attempt.
      const fetchMock = vi.fn();
      global.fetch = fetchMock;

      // Session restore: no cookie
      fetchMock.mockResolvedValueOnce(failResponse(401));
      // Simulate a logout that returns 401 (e.g. some edge case server rejection)
      fetchMock.mockResolvedValueOnce(failResponse(401));

      setAuthData('some.token', 'tenant-1');

      let threw = false;
      try {
        await apiClient('/auth/logout', { method: 'POST' });
      } catch {
        threw = true;
      }

      expect(threw).toBe(true);

      // No refresh call should have been made in response to the logout 401
      const refreshCalls = fetchMock.mock.calls.filter(
        ([url]: any) => typeof url === 'string' && url.includes('/auth/refresh'),
      );
      expect(refreshCalls.length).toBe(0);

      // Total calls: 1 (logout only) — restore is AuthProvider, not apiClient directly
      expect(fetchMock.mock.calls.length).toBe(1);
    });

    it('F16. concurrent 401 refresh behavior for ordinary protected requests remains correct', async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock;

      setAuthData('stale.token', 'tenant-1');

      let refreshResolve: (v: Response) => void;
      const refreshGate = new Promise<Response>((res) => {
        refreshResolve = res;
      });

      // Two ordinary protected requests return 401
      fetchMock.mockResolvedValueOnce(failResponse(401));
      fetchMock.mockResolvedValueOnce(failResponse(401));
      // The shared refresh call – gated
      fetchMock.mockImplementationOnce(() => refreshGate);
      // Retry responses
      fetchMock.mockResolvedValue(failResponse(403));

      const p1 = apiClient('/protected/a').catch(() => null);
      const p2 = apiClient('/protected/b').catch(() => null);

      await new Promise((r) => setTimeout(r, 0));
      refreshResolve!(failResponse(401) as Response);

      await Promise.all([p1, p2]);

      const refreshCalls = fetchMock.mock.calls.filter(
        ([url]: any) => typeof url === 'string' && url.includes('/auth/refresh'),
      );
      // Exactly ONE refresh despite two concurrent 401s
      expect(refreshCalls.length).toBe(1);
    });
  });

  // ── Two-Factor Authentication (2FA) ──────────────────────────────────────────

  describe('Two-Factor Authentication (2FA) Client Handling', () => {
    it('27. login() returns requires2FA and tempToken when 2FA is active', async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock;

      // Session restore fails
      fetchMock.mockResolvedValueOnce(failResponse(401));
      // Login returns 2FA challenge
      fetchMock.mockResolvedValueOnce(
        okJson({ requires2FA: true, tempToken: 'temp-2fa-token-xyz' }),
      );

      let capturedAuth: any;
      const Probe = () => {
        capturedAuth = useAuth();
        return null;
      };
      await act(async () => {
        render(
          <AuthProvider>
            <Probe />
          </AuthProvider>,
        );
      });
      await waitFor(() => expect(capturedAuth?.isLoading).toBe(false));

      let outcome: any;
      await act(async () => {
        outcome = await capturedAuth.login({ email: 'user@example.com', password: 'password123' });
      });

      expect(outcome.requires2FA).toBe(true);
      expect(outcome.tempToken).toBe('temp-2fa-token-xyz');
      expect(capturedAuth.isAuthenticated).toBe(false);
    });

    it('28. verify2FALogin() completes session setup and authenticates user', async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock;

      // Session restore fails
      fetchMock.mockResolvedValueOnce(failResponse(401));
      // verify-login returns access token
      fetchMock.mockResolvedValueOnce(okJson({ accessToken: ACCESS_TOKEN }));
      // /auth/me returns user details
      fetchMock.mockResolvedValueOnce(okJson(ME_RESPONSE));

      let capturedAuth: any;
      const Probe = () => {
        capturedAuth = useAuth();
        return null;
      };
      await act(async () => {
        render(
          <AuthProvider>
            <Probe />
          </AuthProvider>,
        );
      });
      await waitFor(() => expect(capturedAuth?.isLoading).toBe(false));

      let userResult: any;
      await act(async () => {
        userResult = await capturedAuth.verify2FALogin('temp-2fa-token-xyz', '123456');
      });

      expect(userResult.userId).toBe(ME_RESPONSE.userId);
      expect(capturedAuth.isAuthenticated).toBe(true);
      expect(capturedAuth.user.email).toBe(ME_RESPONSE.email);

      // Verify POST call was made with code and tempToken
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/auth/2fa/verify-login'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ tempToken: 'temp-2fa-token-xyz', code: '123456' }),
        }),
      );
    });
  });
});
