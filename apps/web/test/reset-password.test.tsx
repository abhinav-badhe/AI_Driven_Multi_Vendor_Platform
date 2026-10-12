import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ResetPasswordPage } from '../src/features/auth/ResetPasswordPage';
import { AccountPage } from '../src/features/auth/AccountPage';
import { AuthProvider } from '../src/features/auth/AuthContext';

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('Password Reset Frontend Feature', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('ResetPasswordPage displays invalid link warning when token parameter is absent', () => {
    render(
      <MemoryRouter initialEntries={['/reset-password']}>
        <AuthProvider>
          <Routes>
            <Route path="/reset-password" element={<ResetPasswordPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText('Invalid Reset Link')).toBeDefined();
    expect(screen.getByText(/missing a valid reset token/i)).toBeDefined();
    expect(screen.getByText(/Back to Sign in/i)).toBeDefined();
  });

  it('ResetPasswordPage displays reset form when valid token is present and handles submit', async () => {
    global.fetch = vi.fn().mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('/auth/refresh')) {
        return Promise.resolve({ ok: false, status: 401 });
      }
      if (typeof url === 'string' && url.includes('/auth/reset-password')) {
        return Promise.resolve(okJson({ message: 'Password has been successfully reset.' }));
      }
      return Promise.resolve(okJson({}));
    });

    render(
      <MemoryRouter initialEntries={['/reset-password?token=sample-reset-token-123']}>
        <AuthProvider>
          <Routes>
            <Route path="/reset-password" element={<ResetPasswordPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText('Set New Password')).toBeDefined();
    const newPasswordInput = screen.getByLabelText('New Password');
    const confirmPasswordInput = screen.getByLabelText('Confirm New Password');

    fireEvent.change(newPasswordInput, { target: { value: 'brandNewPassword123!' } });
    fireEvent.change(confirmPasswordInput, { target: { value: 'brandNewPassword123!' } });

    const submitBtn = screen.getByRole('button', { name: /Reset Password/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Password Reset Complete')).toBeDefined();
      expect(screen.getByText(/Sign in to your account/i)).toBeDefined();
    });
  });

  it('AccountPage allows toggling into Forgot Password mode and submitting request', async () => {
    global.fetch = vi.fn().mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('/auth/refresh')) {
        return Promise.resolve({ ok: false, status: 401 });
      }
      if (typeof url === 'string' && url.includes('/auth/forgot-password')) {
        return Promise.resolve(
          okJson({
            message: 'If an account exists with this email, a password reset link has been sent.',
          }),
        );
      }
      return Promise.resolve(okJson({}));
    });

    render(
      <MemoryRouter initialEntries={['/account']}>
        <AuthProvider>
          <AccountPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    // Wait for auth initialization to complete
    await waitFor(() => {
      expect(screen.queryByText('Loading account…')).toBeNull();
    });

    // Click "Forgot password?"
    const forgotBtn = screen.getByRole('button', { name: /Forgot password\?/i });
    fireEvent.click(forgotBtn);

    expect(screen.getByText('Forgot your password?')).toBeDefined();
    const emailInput = screen.getByLabelText('Account Email');
    fireEvent.change(emailInput, { target: { value: 'customer@example.com' } });

    const sendBtn = screen.getByRole('button', { name: /Send Reset Link/i });
    fireEvent.click(sendBtn);

    await waitFor(() => {
      expect(screen.getByText(/password reset link has been sent/i)).toBeDefined();
    });
  });
});
