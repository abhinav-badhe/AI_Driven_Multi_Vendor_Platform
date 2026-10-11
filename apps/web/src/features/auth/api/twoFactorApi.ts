import { apiClient } from '../../../api/client';

export interface TwoFactorStatusResponse {
  isEnabled: boolean;
}

export interface TwoFactorSetupResponse {
  secret: string;
  otpAuthUri: string;
  recoveryCodes: string[];
}

export interface TwoFactorSuccessResponse {
  success: boolean;
  message?: string;
}

export const twoFactorApi = {
  async getStatus(): Promise<TwoFactorStatusResponse> {
    return apiClient<TwoFactorStatusResponse>('/auth/2fa/status');
  },

  async setup(issuer = 'Commerce Platform'): Promise<TwoFactorSetupResponse> {
    return apiClient<TwoFactorSetupResponse>('/auth/2fa/setup', {
      method: 'POST',
      body: JSON.stringify({ issuer }),
    });
  },

  async enable(code: string): Promise<TwoFactorSuccessResponse> {
    return apiClient<TwoFactorSuccessResponse>('/auth/2fa/enable', {
      method: 'POST',
      body: JSON.stringify({ code: code.trim() }),
    });
  },

  async disable(password: string, code?: string): Promise<TwoFactorSuccessResponse> {
    return apiClient<TwoFactorSuccessResponse>('/auth/2fa/disable', {
      method: 'POST',
      body: JSON.stringify({ password, code: code?.trim() || undefined }),
    });
  },
};
