import { describe, it, expect, vi } from 'vitest';
import { HttpMerchantClient } from '../src/modules/merchant/internal/http-merchant-client.js';
import { InMemoryMerchantStore } from '../src/modules/merchant/internal/in-memory-merchant-store.js';
import type { AuthorizedActor } from '../src/modules/identity/rbac/policy.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ExternalServiceError,
} from '../src/errors/app-error.js';

describe('HttpMerchantClient', () => {
  const adminActor: AuthorizedActor = {
    userId: 'admin-1',
    role: 'ADMINISTRATOR',
    tenantId: 'platform-tenant',
  };

  const merchantActor: AuthorizedActor = {
    userId: 'merchant-user-1',
    role: 'MERCHANT',
    tenantId: 'tenant-acme',
  };

  const sampleMerchantDto = {
    id: 'merch-123',
    tenantId: 'tenant-acme',
    businessName: 'Acme Superstore',
    legalName: 'Acme Superstore LLC',
    contactEmail: 'contact@acme.com',
    verificationStatus: 'DRAFT' as const,
    rejectionReason: undefined,
    verifiedAt: undefined,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  };

  it('onboards a merchant via HTTP POST with identity headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => sampleMerchantDto,
    });

    const client = new HttpMerchantClient('http://merchant-service:4003', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.onboard(merchantActor, {
      businessName: 'Acme Superstore',
      legalName: 'Acme Superstore LLC',
      contactEmail: 'contact@acme.com',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://merchant-service:4003/merchants/onboard',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-user-id': 'merchant-user-1',
          'x-tenant-id': 'tenant-acme',
          'x-user-role': 'MERCHANT',
          'content-type': 'application/json',
        }),
      }),
    );
    expect(result.id).toBe('merch-123');
    expect(result.businessName).toBe('Acme Superstore');
  });

  it('retrieves merchant profile for current actor via GET /merchants/me', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => sampleMerchantDto,
    });

    const client = new HttpMerchantClient('http://merchant-service:4003', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const profile = await client.getProfile(merchantActor);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://merchant-service:4003/merchants/me',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'x-user-id': 'merchant-user-1',
          'x-tenant-id': 'tenant-acme',
          'x-user-role': 'MERCHANT',
        }),
      }),
    );
    expect(profile.tenantId).toBe('tenant-acme');
  });

  it('retrieves profile by tenantId via internal endpoint and returns null on 404', async () => {
    const mockNotFoundFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ message: 'Not found' }),
    });

    const client = new HttpMerchantClient('http://merchant-service:4003', {
      fetchFn: mockNotFoundFetch as unknown as typeof fetch,
    });

    const profile = await client.getProfileByTenantId('unknown-tenant');
    expect(profile).toBeNull();
  });

  it('updates profile via PATCH /merchants/me', async () => {
    const updatedDto = { ...sampleMerchantDto, businessName: 'Acme Global' };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => updatedDto,
    });

    const client = new HttpMerchantClient('http://merchant-service:4003', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.updateProfile(merchantActor, {
      businessName: 'Acme Global',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://merchant-service:4003/merchants/me',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ businessName: 'Acme Global' }),
      }),
    );
    expect(result.businessName).toBe('Acme Global');
  });

  it('submits profile for verification via POST /merchants/me/submit', async () => {
    const submittedDto = { ...sampleMerchantDto, verificationStatus: 'PENDING' as const };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => submittedDto,
    });

    const client = new HttpMerchantClient('http://merchant-service:4003', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.submitForVerification(merchantActor);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://merchant-service:4003/merchants/me/submit',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.verificationStatus).toBe('PENDING');
  });

  it('approves merchant profile via POST /merchants/:tenantId/approve by admin', async () => {
    const approvedDto = { ...sampleMerchantDto, verificationStatus: 'VERIFIED' as const };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => approvedDto,
    });

    const client = new HttpMerchantClient('http://merchant-service:4003', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.approveMerchant(adminActor, 'tenant-acme');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://merchant-service:4003/merchants/tenant-acme/approve',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.verificationStatus).toBe('VERIFIED');
  });

  it('rejects merchant profile via POST /merchants/:tenantId/reject by admin', async () => {
    const rejectedDto = {
      ...sampleMerchantDto,
      verificationStatus: 'REJECTED' as const,
      rejectionReason: 'Invalid documentation',
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => rejectedDto,
    });

    const client = new HttpMerchantClient('http://merchant-service:4003', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.rejectMerchant(adminActor, 'tenant-acme', 'Invalid documentation');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://merchant-service:4003/merchants/tenant-acme/reject',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: 'Invalid documentation' }),
      }),
    );
    expect(result.verificationStatus).toBe('REJECTED');
  });

  it('correctly maps 400, 403, 409, 404 HTTP status errors into domain exceptions', async () => {
    const makeErrorClient = (status: number, message: string) =>
      new HttpMerchantClient('http://merchant-service:4003', {
        fetchFn: vi.fn().mockResolvedValue({
          ok: false,
          status,
          json: async () => ({ message }),
          text: async () => message,
        }) as unknown as typeof fetch,
      });

    await expect(
      makeErrorClient(400, 'Invalid legal name').onboard(merchantActor, {
        businessName: 'A',
        legalName: 'B',
        contactEmail: 'invalid',
      }),
    ).rejects.toThrowError(ValidationError);

    await expect(
      makeErrorClient(403, 'Forbidden action').approveMerchant(merchantActor, 'other-tenant'),
    ).rejects.toThrowError(ForbiddenError);

    await expect(
      makeErrorClient(409, 'Merchant already onboarded').onboard(merchantActor, {
        businessName: 'A',
        legalName: 'B',
        contactEmail: 'a@b.com',
      }),
    ).rejects.toThrowError(ConflictError);

    await expect(
      makeErrorClient(404, 'Merchant not found').getProfile(merchantActor),
    ).rejects.toThrowError(NotFoundError);
  });

  it('seamlessly falls back to local fallbackService on network error', async () => {
    const fallbackStore = new InMemoryMerchantStore();
    await fallbackStore.onboard(merchantActor, {
      businessName: 'Local Fallback Store',
      legalName: 'Local Fallback LLC',
      contactEmail: 'fallback@acme.com',
    });

    const client = new HttpMerchantClient('http://merchant-service:4003', {
      fetchFn: vi.fn().mockRejectedValue(new Error('Network connection refused')),
      fallbackService: fallbackStore,
    });

    // Network fails -> automatically fetches from fallback service!
    const profile = await client.getProfile(merchantActor);
    expect(profile).not.toBeNull();
    expect(profile.businessName).toBe('Local Fallback Store');

    const byTenant = await client.getProfileByTenantId('tenant-acme');
    expect(byTenant).not.toBeNull();
    expect(byTenant?.businessName).toBe('Local Fallback Store');
  });

  it('throws ExternalServiceError when network fails and no fallbackService is configured', async () => {
    const client = new HttpMerchantClient('http://merchant-service:4003', {
      fetchFn: vi.fn().mockRejectedValue(new Error('Network connection refused')),
    });

    await expect(client.getProfile(merchantActor)).rejects.toThrowError(ExternalServiceError);
  });
});
