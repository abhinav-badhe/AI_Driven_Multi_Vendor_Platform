import { createContext, useContext, useState, ReactNode, useEffect, useCallback } from 'react';
import { setAuthData, setAuthFailureHandler, apiClient, ApiError } from '../../api/client';

export interface UserContext {
  userId: string;
  email: string;
  tenantId: string;
  role: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData {
  email: string;
  password: string;
  tenantName: string;
  role: 'MERCHANT' | 'CUSTOMER';
}

export interface RegisterResult {
  userId: string;
  email: string;
  requiresVerification: boolean;
}

export const isEmailNotVerifiedError = (err: unknown): boolean =>
  err instanceof ApiError && err.code === 'EMAIL_NOT_VERIFIED';

export type LoginResult = UserContext | { requires2FA: true; tempToken: string };

interface AuthContextType {
  user: UserContext | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (credentials: LoginCredentials) => Promise<LoginResult>;
  verify2FALogin: (tempToken: string, code: string) => Promise<UserContext>;
  register: (data: RegisterData) => Promise<RegisterResult>;
  verifyEmail: (token: string) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;
  forgotPassword: (email: string) => Promise<{ message: string }>;
  resetPassword: (token: string, password: string) => Promise<{ message: string }>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

// Single-flight session restore shared across mounts. Two concurrent
// refresh POSTs with the same cookie race the server's rotation: the loser
// looks exactly like token theft, the family gets revoked, and the user is
// signed out everywhere. One restore per page lifetime, awaited by all.
let restorePromise: Promise<UserContext | null> | null = null;

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<UserContext | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const clearAuth = useCallback(() => {
    setUser(null);
    setAuthData(null, null);
  }, []);

  useEffect(() => {
    setAuthFailureHandler(clearAuth);
  }, [clearAuth]);

  useEffect(() => {
    // Session restoration
    let mounted = true;
    if (!restorePromise) {
      restorePromise = (async (): Promise<UserContext | null> => {
        try {
          const refreshRes = await fetch('/api/auth/refresh', {
            method: 'POST',
            credentials: 'include',
          });

          if (!refreshRes.ok) {
            setAuthData(null, null);
            return null;
          }
          const { accessToken } = await refreshRes.json();
          // We need to fetch /auth/me to get the user state because we only have the token
          setAuthData(accessToken, null);
          const me = await apiClient<UserContext>('/auth/me');
          setAuthData(accessToken, me.tenantId);
          return me;
        } catch {
          setAuthData(null, null);
          return null;
        } finally {
          restorePromise = null;
        }
      })();
    }
    restorePromise.then((me) => {
      if (!mounted) return;
      if (me) setUser(me);
      else clearAuth();
      setIsLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [clearAuth]);


  const login = useCallback(async (credentials: LoginCredentials): Promise<LoginResult> => {
    const res = await apiClient<{ accessToken?: string; requires2FA?: boolean; tempToken?: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });

    if (res.requires2FA && res.tempToken) {
      return { requires2FA: true, tempToken: res.tempToken };
    }

    if (!res.accessToken) {
      throw new Error('Login failed: invalid response from server');
    }

    setAuthData(res.accessToken, null);
    const me = await apiClient<UserContext>('/auth/me');
    setAuthData(res.accessToken, me.tenantId);
    setUser(me);
    return me;
  }, [setUser]);

  const verify2FALogin = useCallback(async (tempToken: string, code: string): Promise<UserContext> => {
    const res = await apiClient<{ accessToken: string }>('/auth/2fa/verify-login', {
      method: 'POST',
      body: JSON.stringify({ tempToken, code: code.trim() }),
    });
    setAuthData(res.accessToken, null);
    const me = await apiClient<UserContext>('/auth/me');
    setAuthData(res.accessToken, me.tenantId);
    setUser(me);
    return me;
  }, [setUser]);

  const register = useCallback(async (data: RegisterData): Promise<RegisterResult> => {
    // Signup creates an UNVERIFIED account and emails a verification link.
    // No session is issued — the user signs in after verifying.
    const res = await apiClient<RegisterResult>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return res;
  }, []);

  const verifyEmail = useCallback(async (token: string): Promise<void> => {
    await apiClient<{ verified: boolean }>('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  }, []);

  const resendVerification = useCallback(async (email: string): Promise<void> => {
    await apiClient<{ message: string }>('/auth/resend-verification', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }, []);

  const forgotPassword = useCallback(async (email: string): Promise<{ message: string }> => {
    return await apiClient<{ message: string }>('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }, []);

  const resetPassword = useCallback(async (token: string, password: string): Promise<{ message: string }> => {
    return await apiClient<{ message: string }>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
  }, []);

  const logout = async () => {
    try {
      await apiClient('/auth/logout', { method: 'POST' });
    } finally {
      clearAuth();
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        login,
        verify2FALogin,
        register,
        verifyEmail,
        resendVerification,
        forgotPassword,
        resetPassword,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    return {
      user: null,
      isAuthenticated: false,
      isLoading: false,
      login: async () => ({} as UserContext),
      verify2FALogin: async () => ({} as UserContext),
      register: async () => ({} as RegisterResult),
      verifyEmail: async () => {},
      resendVerification: async () => {},
      forgotPassword: async () => ({ message: '' }),
      resetPassword: async () => ({ message: '' }),
      logout: async () => {},
    };
  }
  return ctx;
};

