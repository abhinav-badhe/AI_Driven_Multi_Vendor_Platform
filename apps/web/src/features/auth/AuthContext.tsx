import { createContext, useContext, useState, ReactNode, useEffect, useCallback } from 'react';
import { setAuthData, setAuthFailureHandler, apiClient } from '../../api/client';

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

interface AuthContextType {
  user: UserContext | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (credentials: LoginCredentials) => Promise<UserContext>;
  register: (data: RegisterData) => Promise<UserContext>;
  logout: () => Promise<void>;

}

const AuthContext = createContext<AuthContextType | null>(null);

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
    const restoreSession = async () => {
      try {
        const refreshRes = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
        });
        
        if (refreshRes.ok) {
          const { accessToken } = await refreshRes.json();
          // We need to fetch /auth/me to get the user state because we only have the token
          setAuthData(accessToken, null);
          const me = await apiClient<UserContext>('/auth/me');
          if (mounted) {
            setAuthData(accessToken, me.tenantId);
            setUser(me);
          }
        } else {
          if (mounted) clearAuth();
        }
      } catch {
        if (mounted) clearAuth();
      } finally {
        if (mounted) setIsLoading(false);
      }
    };
    restoreSession();
    return () => { mounted = false; };
  }, [clearAuth]);


  const login = async (credentials: LoginCredentials): Promise<UserContext> => {
    const res = await apiClient<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
    setAuthData(res.accessToken, null);
    const me = await apiClient<UserContext>('/auth/me');
    setAuthData(res.accessToken, me.tenantId);
    setUser(me);
    return me;
  };

  const register = async (data: RegisterData): Promise<UserContext> => {
    const res = await apiClient<{ accessToken: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    setAuthData(res.accessToken, null);
    const me = await apiClient<UserContext>('/auth/me');
    setAuthData(res.accessToken, me.tenantId);
    setUser(me);
    return me;
  };


  const logout = async () => {
    try {
      await apiClient('/auth/logout', { method: 'POST' });
    } finally {
      clearAuth();
    }
  };

  return (
    <AuthContext.Provider value={{ user, isAuthenticated: !!user, isLoading, login, register, logout }}>
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
      login: async () => {},
      register: async () => {},
      logout: async () => {},
    };
  }
  return ctx;
};
