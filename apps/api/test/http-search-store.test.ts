import { describe, it, expect, vi } from 'vitest';
import {
  HttpSearchStoreAdapter,
  InMemorySearchStore,
  type SearchProductDocument,
  type SearchQueryParams,
} from '../src/modules/search/index.js';
import { ExternalServiceError } from '../src/errors/app-error.js';

describe('Domain 14: Search HTTP Adapter (HttpSearchStoreAdapter)', () => {
  const sampleDoc: SearchProductDocument = {
    id: 'prod-101',
    title: 'Wireless Mechanical Keyboard',
    slug: 'wireless-mechanical-keyboard',
    description: 'Hot-swappable tactile RGB gaming keyboard',
    brand: 'KeyChronicle',
    categoryId: 'cat-peripherals',
    categoryName: 'Peripherals',
    status: 'ACTIVE',
    offers: [
      {
        listingId: 'list-1',
        merchantId: 'merch-1',
        merchantName: 'TechDepot',
        skuId: 'sku-1',
        skuCode: 'KEY-RGB-01',
        priceAmount: 8999,
        currency: 'USD',
        status: 'ACTIVE',
        inStock: true,
        availableQuantity: 15,
        attributes: {},
        sourceVersion: 1,
        updatedAt: '2026-10-10T12:00:00Z',
      },
    ],
    minPrice: 8999,
    maxPrice: 8999,
    currency: 'USD',
    hasInStockOffer: true,
    totalOffersCount: 1,
    attributes: { switch: 'Tactile Brown', connectivity: 'Bluetooth' },
    sourceVersion: 1,
    projectionVersion: 1,
    createdAt: '2026-10-10T12:00:00Z',
    updatedAt: '2026-10-10T12:00:00Z',
  };

  it('delegates faceted search query to remote service and normalizes scores map', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [sampleDoc],
        scores: { 'prod-101': 85.5 },
        total: 1,
        facets: {
          categories: [{ id: 'cat-peripherals', name: 'Peripherals', count: 1 }],
          brands: [{ name: 'KeyChronicle', count: 1 }],
          priceRange: { min: 8999, max: 8999 },
          attributes: {},
        },
      }),
    });

    const store = new HttpSearchStoreAdapter('http://search-service:4050', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const queryParams: SearchQueryParams = { q: 'keyboard', minPrice: 5000 };
    const result = await store.search(queryParams);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://search-service:4050/v1/search',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(queryParams),
      }),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe('prod-101');
    expect(result.total).toBe(1);
    expect(result.scores.get('prod-101')).toBe(85.5);
    expect(result.facets.brands[0]!.name).toBe('KeyChronicle');
  });

  it('indexes documents via POST /v1/documents', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ status: 'created' }),
    });

    const store = new HttpSearchStoreAdapter('http://search-service:4050', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await store.indexDocument(sampleDoc);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://search-service:4050/v1/documents',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(sampleDoc),
      }),
    );
  });

  it('bulk indexes documents via POST /v1/documents/bulk', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ indexed: 1 }),
    });

    const store = new HttpSearchStoreAdapter('http://search-service:4050', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await store.bulkIndex([sampleDoc]);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://search-service:4050/v1/documents/bulk',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ documents: [sampleDoc] }),
      }),
    );
  });

  it('replaces projection via POST /v1/documents/replace', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ replaced: 1 }),
    });

    const store = new HttpSearchStoreAdapter('http://search-service:4050', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await store.replaceProjection([sampleDoc]);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://search-service:4050/v1/documents/replace',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ documents: [sampleDoc] }),
      }),
    );
  });

  it('retrieves single document and returns null on 404', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => sampleDoc,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

    const store = new HttpSearchStoreAdapter('http://search-service:4050', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const found = await store.getDocument('prod-101');
    expect(found).toEqual(sampleDoc);

    const missing = await store.getDocument('prod-999');
    expect(missing).toBeNull();
  });

  it('deletes document via DELETE /v1/documents/:id', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ deleted: true }),
    });

    const store = new HttpSearchStoreAdapter('http://search-service:4050', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const deleted = await store.deleteDocument('prod-101');
    expect(deleted).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://search-service:4050/v1/documents/prod-101',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('executes count and health check endpoints', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ count: 42 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'healthy', count: 42, engine: 'elasticsearch' }),
      });

    const store = new HttpSearchStoreAdapter('http://search-service:4050', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(await store.count()).toBe(42);
    expect(await store.healthCheck()).toEqual({
      status: 'healthy',
      count: 42,
      engine: 'elasticsearch',
    });
  });

  it('finds product ID by listing ID', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ productId: 'prod-101' }),
    });

    const store = new HttpSearchStoreAdapter('http://search-service:4050', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const productId = await store.findProductIdByListingId('list-1');
    expect(productId).toBe('prod-101');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://search-service:4050/v1/listings/list-1/product-id',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('resiliently falls back to local store when remote search fails', async () => {
    const fallbackStore = new InMemorySearchStore();
    await fallbackStore.indexDocument(sampleDoc);

    const failingFetch = vi.fn().mockRejectedValue(new Error('Network connection refused'));

    const store = new HttpSearchStoreAdapter('http://search-service:4050', {
      fetchFn: failingFetch as unknown as typeof fetch,
      fallbackStore,
    });

    // Remote fails -> falls back seamlessly to local store
    const result = await store.search({ q: 'keyboard' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe('prod-101');
  });

  it('throws ExternalServiceError when remote fails and no fallback store is provided', async () => {
    const failingFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    });

    const store = new HttpSearchStoreAdapter('http://search-service:4050', {
      fetchFn: failingFetch as unknown as typeof fetch,
    });

    await expect(store.search({ q: 'keyboard' })).rejects.toThrowError(ExternalServiceError);
  });
});
