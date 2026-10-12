import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Home } from '../src/features/home/Home';
import { CategoryPage } from '../src/features/catalog/Category';
import { ProductPage } from '../src/features/catalog/Product';
import { __resetClientCacheForTests } from '../src/api/client';

const createFetchResponse = (data: any, status = 200, ok = true) => {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(data),
  } as Response);
};

describe('Catalog & Marketplace Frontend Tests', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    // The apiClient response cache is module-level: reset between tests so
    // one test's cached entries never satisfy another test's fetches.
    __resetClientCacheForTests();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Home Page (Categories)', () => {
    it('shows loading state initially', async () => {
      // Return a never-resolving promise to keep it in loading state
      fetchMock.mockImplementationOnce(() => new Promise(() => {}));

      await act(async () => {
        render(
          <MemoryRouter>
            <Home />
          </MemoryRouter>,
        );
      });
      // Skeleton placeholder shaped like the product list (STYLE.md §6)
      expect(screen.getByLabelText(/Loading products/i)).toBeDefined();
    });

    it('renders categories from real API contract', async () => {
      const mockCategories = [
        { id: 'cat1', name: 'Electronics', parentId: null },
        { id: 'cat2', name: 'Books', parentId: null },
      ];
      fetchMock.mockImplementation((url: string) => {
        if (url.includes('/categories')) return createFetchResponse(mockCategories);
        if (url.includes('/recommendations')) return createFetchResponse({ items: [] });
        if (url.includes('/search')) return createFetchResponse({ items: [] });
        return createFetchResponse({});
      });

      await act(async () => {
        render(
          <MemoryRouter>
            <Home />
          </MemoryRouter>,
        );
      });

      await waitFor(() => {
        expect(screen.getAllByText('Electronics').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Books').length).toBeGreaterThan(0);
      });
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/categories'),
        expect.any(Object),
      );
    });

    it('handles backend failure gracefully', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network Error'));

      await act(async () => {
        render(
          <MemoryRouter>
            <Home />
          </MemoryRouter>,
        );
      });

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeDefined();
        expect(screen.getByText(/could not be loaded/i)).toBeDefined();
      });
    });

    it('shows empty state when no categories exist', async () => {
      fetchMock.mockResolvedValueOnce(createFetchResponse([]));

      await act(async () => {
        render(
          <MemoryRouter>
            <Home />
          </MemoryRouter>,
        );
      });

      await waitFor(() => {
        expect(screen.getByText(/No categories found/i)).toBeDefined();
      });
    });
  });

  describe('Category Page (Products)', () => {
    it('renders category name and product list', async () => {
      const mockCategory = { id: 'cat1', name: 'Electronics' };
      const mockProducts = [
        { id: 'p1', title: 'Laptop', description: 'A nice laptop', brand: 'TechBrand' },
        { id: 'p2', title: 'Phone', description: 'A nice phone', brand: 'PhoneBrand' },
      ];

      // First call is getCategory, second is getProducts
      fetchMock.mockImplementation((url: string) => {
        if (url.includes('/categories/cat1')) return createFetchResponse(mockCategory);
        if (url.includes('/products?')) return createFetchResponse(mockProducts);
        return createFetchResponse({});
      });

      await act(async () => {
        render(
          <MemoryRouter initialEntries={['/category/cat1']}>
            <Routes>
              <Route path="/category/:id" element={<CategoryPage />} />
            </Routes>
          </MemoryRouter>,
        );
      });

      await waitFor(() => {
        expect(screen.getAllByText('Electronics').length).toBeGreaterThan(0);
        expect(screen.getByText('Laptop')).toBeDefined();
        expect(screen.getByText('Phone')).toBeDefined();
        expect(screen.getByText('TechBrand')).toBeDefined();
      });
    });

    it('shows empty state when category has no active products', async () => {
      const mockCategory = { id: 'cat1', name: 'Electronics' };

      fetchMock.mockImplementation((url: string) => {
        if (url.includes('/categories/cat1')) return createFetchResponse(mockCategory);
        if (url.includes('/products?')) return createFetchResponse([]); // No products
        return createFetchResponse({});
      });

      await act(async () => {
        render(
          <MemoryRouter initialEntries={['/category/cat1']}>
            <Routes>
              <Route path="/category/:id" element={<CategoryPage />} />
            </Routes>
          </MemoryRouter>,
        );
      });

      await waitFor(() => {
        expect(screen.getByText(/No products currently available in this category/i)).toBeDefined();
      });
    });
  });

  describe('Product Page (Details & Listings)', () => {
    it('renders actual product data, variants, and multiple merchant listings', async () => {
      const mockProduct = {
        id: 'p1',
        title: 'Laptop',
        description: 'A nice laptop',
        brand: 'TechBrand',
      };
      const mockSkus = [
        { id: 'sku1', skuCode: 'LAPTOP-RED', status: 'ACTIVE' },
        { id: 'sku2', skuCode: 'LAPTOP-BLUE', status: 'ACTIVE' },
      ];
      const mockListings = [
        {
          id: 'list1',
          tenantId: 'm1',
          priceAmount: 99999,
          currency: 'USD',
          compareAtPrice: 120000,
        },
        { id: 'list2', tenantId: 'm2', priceAmount: 95000, currency: 'USD', compareAtPrice: null },
      ];

      fetchMock.mockImplementation((url: string) => {
        if (url.endsWith('/products/p1')) return createFetchResponse(mockProduct);
        if (url.endsWith('/products/p1/skus')) return createFetchResponse(mockSkus);
        if (url.endsWith('/skus/sku1/listings')) return createFetchResponse(mockListings);
        return createFetchResponse({});
      });

      await act(async () => {
        render(
          <MemoryRouter initialEntries={['/product/p1']}>
            <Routes>
              <Route path="/product/:id" element={<ProductPage />} />
            </Routes>
          </MemoryRouter>,
        );
      });

      // Product Details
      await waitFor(() => {
        expect(screen.getByText('Laptop')).toBeDefined();
        expect(screen.getByText('TechBrand')).toBeDefined();
      });

      // SKUs rendered
      expect(screen.getByText('LAPTOP-RED')).toBeDefined();
      expect(screen.getByText('LAPTOP-BLUE')).toBeDefined();

      // Marketplace Listings rendered for the default selected SKU (sku1)
      await waitFor(() => {
        expect(screen.getByText(/999\.99 USD/)).toBeDefined();
        expect(screen.getByText(/1200\.00 USD/)).toBeDefined(); // compareAtPrice
        expect(screen.getByText(/950\.00 USD/)).toBeDefined();
      });

      // Fetch was called with correct SKU ID
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/skus/sku1/listings'),
        expect.any(Object),
      );
    });

    it('shows listing unavailable empty state when no active listings exist', async () => {
      const mockProduct = { id: 'p1', title: 'Laptop' };
      const mockSkus = [{ id: 'sku1', skuCode: 'LAPTOP-RED', status: 'ACTIVE' }];

      fetchMock.mockImplementation((url: string) => {
        if (url.endsWith('/products/p1')) return createFetchResponse(mockProduct);
        if (url.endsWith('/products/p1/skus')) return createFetchResponse(mockSkus);
        if (url.endsWith('/skus/sku1/listings')) return createFetchResponse([]); // No listings
        return createFetchResponse({});
      });

      await act(async () => {
        render(
          <MemoryRouter initialEntries={['/product/p1']}>
            <Routes>
              <Route path="/product/:id" element={<ProductPage />} />
            </Routes>
          </MemoryRouter>,
        );
      });

      await waitFor(() => {
        expect(screen.getByText(/No merchants are actively selling this item/i)).toBeDefined();
      });
    });

    it('shows 404/not-found state when product fetch fails (404)', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url.endsWith('/products/p1'))
          return createFetchResponse({ message: 'Not found' }, 404, false);
        return createFetchResponse({});
      });

      await act(async () => {
        render(
          <MemoryRouter initialEntries={['/product/p1']}>
            <Routes>
              <Route path="/product/:id" element={<ProductPage />} />
            </Routes>
          </MemoryRouter>,
        );
      });

      // apiClient throws on non-ok responses
      await waitFor(() => {
        expect(screen.getByText(/Error: Unknown Error/i)).toBeDefined();
      });
    });
  });
});
