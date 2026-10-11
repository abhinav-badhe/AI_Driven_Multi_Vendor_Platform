import { describe, it, expect, vi } from 'vitest';
import { HttpMarketplaceClient } from '../src/modules/marketplace/internal/http-marketplace-client.js';
import { InMemoryMarketplaceStore } from '../src/modules/marketplace/internal/in-memory-marketplace-store.js';
import type { AuthorizedActor } from '../src/modules/identity/rbac/policy.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  InvalidStateTransitionError,
  ExternalServiceError,
} from '../src/errors/app-error.js';

describe('HttpMarketplaceClient', () => {

  const merchantActor: AuthorizedActor = {
    userId: 'merchant-1',
    role: 'MERCHANT',
    tenantId: 'tenant-merchant-1',
  };

  const sampleListingDto = {
    id: 'lst-123',
    tenantId: 'tenant-merchant-1',
    skuId: 'sku-456',
    priceAmount: 4999,
    currency: 'USD',
    compareAtPrice: 5999,
    status: 'ACTIVE' as const,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  };

  const sampleListingDetailDto = {
    ...sampleListingDto,
    skuCode: 'SKU-456',
    productId: 'prod-456',
    productTitle: 'Sample Product',
    productSlug: 'sample-product',
    brand: 'Acme',
    thumbnailUrl: null,
    images: [],
    rating: 4.5,
    reviewCount: 10,
    onHandQuantity: 50,
    reservedQuantity: 0,
    availableQuantity: 50,
    inventoryVersion: 1,
  };

  it('creates listing via HTTP POST with identity headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => sampleListingDto,
    });

    const client = new HttpMarketplaceClient('http://marketplace-service:4004', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.createListing(merchantActor, {
      skuId: 'sku-456',
      priceAmount: 4999,
      currency: 'USD',
      compareAtPrice: 5999,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://marketplace-service:4004/listings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-user-id': 'merchant-1',
          'x-tenant-id': 'tenant-merchant-1',
          'x-user-role': 'MERCHANT',
          'content-type': 'application/json',
        }),
      }),
    );
    expect(result.id).toBe('lst-123');
    expect(result.priceAmount).toBe(4999);
  });

  it('retrieves merchant listings and listing details', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/listings/me/detail')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [sampleListingDetailDto],
        });
      }
      if (url.includes('/listings/me')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [sampleListingDto],
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const client = new HttpMarketplaceClient('http://marketplace-service:4004', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const listings = await client.getMyListings(merchantActor, { status: 'ACTIVE' });
    expect(listings).toHaveLength(1);
    expect(listings[0]?.id).toBe('lst-123');

    const details = await client.getMyListingDetails(merchantActor);
    expect(details).toHaveLength(1);
    expect(details[0]?.skuCode).toBe('SKU-456');
  });

  it('retrieves listing by ID and active listings for SKU', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/listings/lst-123')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => sampleListingDto,
        });
      }
      if (url.includes('/skus/sku-456/listings')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [sampleListingDto],
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const client = new HttpMarketplaceClient('http://marketplace-service:4004', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const listing = await client.getListingById(merchantActor, 'lst-123');
    expect(listing.id).toBe('lst-123');

    const activeListings = await client.getActiveListingsForSku('sku-456');
    expect(activeListings).toHaveLength(1);
    expect(activeListings[0]?.skuId).toBe('sku-456');
  });

  it('updates listing and updates listing status via HTTP', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (init.method === 'PATCH' && url.includes('/listings/lst-123')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ...sampleListingDto, priceAmount: 3999 }),
        });
      }
      if (init.method === 'POST' && url.includes('/listings/lst-123/status')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ...sampleListingDto, status: 'INACTIVE' }),
        });
      }
      return Promise.resolve({ ok: false, status: 400 });
    });

    const client = new HttpMarketplaceClient('http://marketplace-service:4004', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const updated = await client.updateListing(merchantActor, 'lst-123', { priceAmount: 3999 });
    expect(updated.priceAmount).toBe(3999);

    const statusUpdated = await client.setListingStatus(merchantActor, 'lst-123', 'INACTIVE');
    expect(statusUpdated.status).toBe('INACTIVE');
  });

  it('translates 400 to ValidationError and 403 to ForbiddenError', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: 'Invalid priceAmount' }),
    });

    const client = new HttpMarketplaceClient('http://marketplace-service:4004', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(
      client.createListing(merchantActor, {
        skuId: 'sku-456',
        priceAmount: -10,
        currency: 'USD',
      }),
    ).rejects.toThrowError(ValidationError);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ message: 'Tenant mismatch' }),
    });

    await expect(
      client.updateListing(merchantActor, 'lst-123', { priceAmount: 2000 }),
    ).rejects.toThrowError(ForbiddenError);
  });

  it('translates 404 to NotFoundError, 409 to ConflictError, and 422 to InvalidStateTransitionError', async () => {
    const mockFetch = vi.fn();
    const client = new HttpMarketplaceClient('http://marketplace-service:4004', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ message: 'Not found' }),
    });
    await expect(client.getListingById(merchantActor, 'non-existent')).rejects.toThrowError(
      NotFoundError,
    );

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ message: 'Duplicate listing' }),
    });
    await expect(
      client.createListing(merchantActor, {
        skuId: 'sku-456',
        priceAmount: 100,
        currency: 'USD',
      }),
    ).rejects.toThrowError(ConflictError);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({ message: 'Invalid status transition' }),
    });
    await expect(client.setListingStatus(merchantActor, 'lst-123', 'SUSPENDED')).rejects.toThrowError(
      InvalidStateTransitionError,
    );
  });

  it('falls back to local InMemoryMarketplaceStore on 500 server error', async () => {
    const fallback = new InMemoryMarketplaceStore();
    const seeded = await fallback.createListing(merchantActor, {
      skuId: 'sku-456',
      priceAmount: 1999,
      currency: 'USD',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const client = new HttpMarketplaceClient('http://marketplace-service:4004', {
      fetchFn: mockFetch as unknown as typeof fetch,
      fallbackService: fallback,
    });

    expect(client.getFallbackService()).toBe(fallback);

    // Call getListingById - should fail remote with 500 and transparently return from fallback
    const result = await client.getListingById(merchantActor, seeded.id);
    expect(result.id).toBe(seeded.id);
    expect(result.priceAmount).toBe(1999);
  });

  it('falls back to local InMemoryMarketplaceStore on network error', async () => {
    const fallback = new InMemoryMarketplaceStore();
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const client = new HttpMarketplaceClient('http://marketplace-service:4004', {
      fetchFn: mockFetch as unknown as typeof fetch,
      fallbackService: fallback,
    });

    const created = await client.createListing(merchantActor, {
      skuId: 'sku-fallback-1',
      priceAmount: 8999,
      currency: 'USD',
    });

    expect(created.skuId).toBe('sku-fallback-1');
    expect(created.priceAmount).toBe(8999);
  });

  it('throws ExternalServiceError on network failure when no fallback is configured', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const client = new HttpMarketplaceClient('http://marketplace-service:4004', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(
      client.createListing(merchantActor, {
        skuId: 'sku-1',
        priceAmount: 1000,
        currency: 'USD',
      }),
    ).rejects.toThrowError(ExternalServiceError);
  });

  it('throws ExternalServiceError on request timeout', async () => {
    const mockFetch = vi.fn().mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('The operation was aborted')), 50);
        }),
    );

    const client = new HttpMarketplaceClient('http://marketplace-service:4004', {
      fetchFn: mockFetch as unknown as typeof fetch,
      timeoutMs: 10,
    });

    await expect(
      client.createListing(merchantActor, {
        skuId: 'sku-1',
        priceAmount: 1000,
        currency: 'USD',
      }),
    ).rejects.toThrowError(ExternalServiceError);
  });
});
