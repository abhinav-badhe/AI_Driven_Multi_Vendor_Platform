import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AppRoutes } from '../src/routes/index.js';
import { AuthProvider, useAuth } from '../src/features/auth/AuthContext.js';
import { CustomerLayout } from '../src/layouts/CustomerLayout.js';
import { MerchantLayout } from '../src/layouts/MerchantLayout.js';
import { AdminLayout } from '../src/layouts/AdminLayout.js';
import { apiClient, ApiError } from '../src/api/client.js';

describe('Frontend Foundation', () => {
  const UNAUTHENTICATED_FETCH = () => Promise.resolve({
    ok: false, status: 401, statusText: 'Unauthorized',
    json: () => Promise.resolve({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }),
  } as unknown as Response);

  beforeEach(() => {
    vi.restoreAllMocks();
    // Default: session restore always fails (no HttpOnly cookie in test env)
    global.fetch = vi.fn().mockImplementation(UNAUTHENTICATED_FETCH);
  });

  afterEach(() => {
    cleanup();
  });

  it('1. App/bootstrap renders successfully', async () => {
    await act(async () => { render(<AppRoutes />); });
    expect(screen.getByText('Commerce')).toBeDefined();
  });

  it('2. Customer route shell renders', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<CustomerLayout />}>
            <Route index element={<div>Customer Content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText('Customer Content')).toBeDefined();
    expect(screen.getByPlaceholderText(/Search products/i)).toBeDefined();
  });

  it('3. Merchant route protection exists (redirects unauthenticated)', async () => {
    await act(async () => {
      render(
        <AuthProvider>
          <MemoryRouter initialEntries={['/merchant']}>
            <Routes>
              <Route path="/merchant" element={<MerchantLayout />}>
                <Route index element={<div>Merchant Content</div>} />
              </Route>
              <Route path="/account" element={<div>Account Login Shell</div>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      );
    });
    await waitFor(() => screen.getByText('Account Login Shell'));
    expect(screen.queryByText('Merchant Content')).toBeNull();
  });

  it('4. Admin route protection exists (redirects unauthenticated)', async () => {
    await act(async () => {
      render(
        <AuthProvider>
          <MemoryRouter initialEntries={['/admin']}>
            <Routes>
              <Route path="/admin" element={<AdminLayout />}>
                <Route index element={<div>Admin Content</div>} />
              </Route>
              <Route path="/account" element={<div>Account Login Shell</div>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      );
    });
    await waitFor(() => screen.getByText('Account Login Shell'));
    expect(screen.queryByText('Admin Content')).toBeNull();
  });

  it('5. AuthContext initial unauthenticated state works', async () => {
    // Suppress the failed /auth/refresh call (no valid cookie in test env)
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }),
    });

    let authState: any;
    const TestComponent = () => {
      authState = useAuth();
      return <div />;
    };

    await act(async () => {
      render(
        <AuthProvider>
          <TestComponent />
        </AuthProvider>
      );
    });

    await waitFor(() => expect(authState?.isLoading).toBe(false));

    expect(authState.isAuthenticated).toBe(false);
    expect(authState.user).toBeNull();
    // refreshToken must never be in AuthContext
    expect('refreshToken' in authState).toBe(false);
  });

  it('6. API client converts an HTTP error into the expected ApiError structure', async () => {
    // Mock global fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: () => Promise.resolve({ error: { code: 'INVALID_INPUT', message: 'Test error' } }),
    });

    try {
      await apiClient('/test');
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.statusCode).toBe(400);
      expect(apiError.code).toBe('INVALID_INPUT');
      expect(apiError.message).toBe('Test error');
    }
  });
});
