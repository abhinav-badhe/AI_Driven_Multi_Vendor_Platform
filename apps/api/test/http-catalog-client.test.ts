import { describe, it, expect, vi } from 'vitest';
import { HttpCatalogClient } from '../src/modules/catalog/internal/http-catalog-client.js';
import { InMemoryCatalogStore } from '../src/modules/catalog/internal/in-memory-catalog-store.js';
import type { AuthorizedActor } from '../src/modules/identity/rbac/policy.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  InvalidStateTransitionError,
  ExternalServiceError,
} from '../src/errors/app-error.js';

describe('HttpCatalogClient', () => {
  const adminActor: AuthorizedActor = {
    userId: 'admin-1',
    role: 'ADMINISTRATOR',
    tenantId: 'platform-tenant',
  };

  const sampleCategoryDto = {
    id: 'cat-123',
    name: 'Electronics',
    slug: 'electronics',
    parentId: null,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  };

  const sampleProductDto = {
    id: 'prod-456',
    title: 'Wireless Headphones',
    slug: 'wireless-headphones',
    description: 'High-fidelity noise cancelling',
    brand: 'AudioTech',
    categoryId: 'cat-123',
    status: 'ACTIVE' as const,
    thumbnailUrl: 'https://images.example.com/thumb.jpg',
    images: ['https://images.example.com/thumb.jpg'],
    rating: 4.8,
    reviewCount: 42,
    attributes: { wireless: true },
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  };

  const sampleSkuDto = {
    id: 'sku-789',
    productId: 'prod-456',
    skuCode: 'AUD-WL-BLK',
    barcode: '123456789012',
    attributes: { color: 'Black' },
    status: 'ACTIVE' as const,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  };

  it('creates category via HTTP POST with identity headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => sampleCategoryDto,
    });

    const client = new HttpCatalogClient('http://catalog-service:4005', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.createCategory(adminActor, {
      name: 'Electronics',
      slug: 'electronics',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://catalog-service:4005/categories',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-user-id': 'admin-1',
          'x-tenant-id': 'platform-tenant',
          'x-user-role': 'ADMINISTRATOR',
          'content-type': 'application/json',
        }),
      }),
    );
    expect(result.id).toBe('cat-123');
    expect(result.name).toBe('Electronics');
  });

  it('retrieves categories list and category by ID', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/categories/cat-123')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => sampleCategoryDto,
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [sampleCategoryDto],
      });
    });

    const client = new HttpCatalogClient('http://catalog-service:4005', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const list = await client.listCategories();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('cat-123');

    const single = await client.getCategoryById('cat-123');
    expect(single.slug).toBe('electronics');
  });

  it('creates and retrieves product via HTTP endpoints', async () => {
    const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => sampleProductDto,
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => sampleProductDto,
      });
    });

    const client = new HttpCatalogClient('http://catalog-service:4005', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const created = await client.createProduct(adminActor, {
      title: 'Wireless Headphones',
      slug: 'wireless-headphones',
      brand: 'AudioTech',
    });
    expect(created.id).toBe('prod-456');

    const fetched = await client.getProductById('prod-456');
    expect(fetched.title).toBe('Wireless Headphones');
  });

  it('updates product and sets product status via PATCH', async () => {
    const updatedProd = { ...sampleProductDto, title: 'Updated Headphones' };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => updatedProd,
    });

    const client = new HttpCatalogClient('http://catalog-service:4005', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const updated = await client.updateProduct(adminActor, 'prod-456', {
      title: 'Updated Headphones',
    });
    expect(updated.title).toBe('Updated Headphones');

    const statusChanged = await client.setProductStatus(adminActor, 'prod-456', 'INACTIVE');
    expect(statusChanged).toBeDefined();
  });

  it('queries product list with filtered search query params', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [sampleProductDto],
    });

    const client = new HttpCatalogClient('http://catalog-service:4005', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.listProducts({
      status: 'ACTIVE',
      brand: 'AudioTech',
      search: 'wireless',
      limit: 10,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://catalog-service:4005/products?status=ACTIVE&brand=AudioTech&search=wireless&limit=10',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result).toHaveLength(1);
  });

  it('manages SKU lifecycle: create, get, list, update, and status transition', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => sampleSkuDto,
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => (url.includes('/skus/') ? sampleSkuDto : [sampleSkuDto]),
      });
    });

    const client = new HttpCatalogClient('http://catalog-service:4005', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const createdSku = await client.createSku(adminActor, 'prod-456', {
      skuCode: 'AUD-WL-BLK',
    });
    expect(createdSku.skuCode).toBe('AUD-WL-BLK');

    const fetchedSku = await client.getSkuById('sku-789');
    expect(fetchedSku.id).toBe('sku-789');

    const productSkus = await client.listSkusByProduct('prod-456', adminActor);
    expect(productSkus).toHaveLength(1);

    const updatedSku = await client.updateSku(adminActor, 'sku-789', {
      barcode: '999999999999',
    });
    expect(updatedSku).toBeDefined();

    const statusSku = await client.setSkuStatus(adminActor, 'sku-789', 'ACTIVE');
    expect(statusSku).toBeDefined();
  });

  it('correctly maps 400, 403, 404, 409, 422 HTTP responses to domain errors', async () => {
    const makeErrorClient = (status: number, message: string) =>
      new HttpCatalogClient('http://catalog-service:4005', {
        fetchFn: vi.fn().mockResolvedValue({
          ok: false,
          status,
          json: async () => ({ message }),
          text: async () => message,
        }) as unknown as typeof fetch,
      });

    await expect(
      makeErrorClient(400, 'Title required').createProduct(adminActor, { title: '', slug: '' }),
    ).rejects.toThrowError(ValidationError);

    await expect(
      makeErrorClient(403, 'Permission denied').createProduct(adminActor, {
        title: 'T',
        slug: 's',
      }),
    ).rejects.toThrowError(ForbiddenError);

    await expect(
      makeErrorClient(404, 'Category not found').getCategoryById('missing'),
    ).rejects.toThrowError(NotFoundError);

    await expect(
      makeErrorClient(409, 'SKU exists').createSku(adminActor, 'prod-1', { skuCode: 'EXIST' }),
    ).rejects.toThrowError(ConflictError);

    await expect(
      makeErrorClient(422, 'Invalid transition').setProductStatus(adminActor, 'prod-1', 'ARCHIVED'),
    ).rejects.toThrowError(InvalidStateTransitionError);
  });

  it('seamlessly falls back to InMemoryCatalogStore on network errors', async () => {
    const fallbackStore = new InMemoryCatalogStore();
    const createdCat = await fallbackStore.createCategory(adminActor, {
      name: 'Fallback Audio',
      slug: 'fallback-audio',
    });
    const createdProd = await fallbackStore.createProduct(adminActor, {
      title: 'Fallback Speaker',
      slug: 'fallback-speaker',
      categoryId: createdCat.id,
    });

    const client = new HttpCatalogClient('http://catalog-service:4005', {
      fetchFn: vi.fn().mockRejectedValue(new Error('Connection refused')),
      fallbackService: fallbackStore,
    });

    // Remote network fails -> automatic fallback!
    const product = await client.getProductById(createdProd.id);
    expect(product).toBeDefined();
    expect(product.title).toBe('Fallback Speaker');

    const categories = await client.listCategories();
    expect(categories).toHaveLength(1);
    expect(categories[0]!.slug).toBe('fallback-audio');
  });

  it('throws ExternalServiceError when network fails and no fallbackService is configured', async () => {
    const client = new HttpCatalogClient('http://catalog-service:4005', {
      fetchFn: vi.fn().mockRejectedValue(new Error('Connection timed out')),
    });

    await expect(client.getProductById('prod-123')).rejects.toThrowError(ExternalServiceError);
  });
});
