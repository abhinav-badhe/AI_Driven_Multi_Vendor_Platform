import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  apiClient,
  prefetch,
  invalidateClientCache,
  __resetClientCacheForTests,
} from '../src/api/client';

const okResponse = (data: unknown) =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  } as Response);

describe('apiClient response cache', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    __resetClientCacheForTests();
  });

  it('serves repeat GETs from cache without a second network call', async () => {
    fetchMock.mockImplementation(() => okResponse([{ id: 'c1', name: 'Cats' }]));

    const first = await apiClient<unknown[]>('/categories');
    const second = await apiClient<unknown[]>('/categories');

    expect(first).toEqual([{ id: 'c1', name: 'Cats' }]);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns clones so callers cannot corrupt the cached entry', async () => {
    fetchMock.mockImplementation(() => okResponse({ items: [1] }));

    const first = await apiClient<{ items: number[] }>('/search?q=shoes');
    first.items.push(2);
    const second = await apiClient<{ items: number[] }>('/search?q=shoes');

    expect(second.items).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache live-state paths such as the cart', async () => {
    fetchMock.mockImplementation(() => okResponse({ id: 'cart-1' }));

    await apiClient('/cart');
    await apiClient('/cart');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('invalidates catalog entries on product writes but not on view pings', async () => {
    fetchMock.mockImplementation(() => okResponse([]));

    await apiClient('/products?limit=5');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Analytics ping — must NOT evict catalog entries.
    await apiClient('/products/p1/views', { method: 'POST', body: '{}' });
    await apiClient('/products?limit=5');
    expect(fetchMock).toHaveBeenCalledTimes(2); // +1 for the POST only

    // True state change — evicts.
    await apiClient('/products/p1/status', { method: 'POST', body: '{}' });
    await apiClient('/products?limit=5');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('prefetch warms the cache for the next navigation', async () => {
    fetchMock.mockImplementation(() => okResponse({ id: 'p1' }));

    prefetch('/products/p1');
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    await apiClient('/products/p1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('invalidateClientCache drops matching entries', async () => {
    fetchMock.mockImplementation(() => okResponse([]));

    await apiClient('/categories');
    invalidateClientCache(['/categories']);
    await apiClient('/categories');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
