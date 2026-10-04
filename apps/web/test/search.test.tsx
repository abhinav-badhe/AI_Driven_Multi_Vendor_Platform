import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SearchPage } from '../src/features/search/SearchPage';
import { searchApi, type SearchResponseDto } from '../src/features/search/api/search';

const mockSearchResponse: SearchResponseDto = {
  items: [
    {
      productId: 'prod-iphone-15',
      title: 'Apple iPhone 15 Pro',
      slug: 'apple-iphone-15-pro',
      description: 'Titanium smartphone',
      brand: 'Apple',
      categoryId: 'cat-phones',
      categoryName: 'Smartphones',
      minPrice: 9500000,
      maxPrice: 10000000,
      currency: 'INR',
      hasInStockOffer: true,
      totalOffersCount: 2,
      bestOffer: {
        listingId: 'list-beta',
        merchantId: 'merchant-beta',
        merchantName: 'Beta Retail',
        skuId: 'sku-1',
        skuCode: 'IPHONE-15-BLK',
        priceAmount: 9500000,
        currency: 'INR',
        status: 'ACTIVE',
        inStock: true,
        availableQuantity: 5,
        attributes: {},
        sourceVersion: 1,
        updatedAt: '2026-10-01T00:00:00Z',
      },
      offers: [],
      attributes: {},
      projectionVersion: 1,
      updatedAt: '2026-10-01T00:00:00Z',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 12,
  totalPages: 1,
  query: 'iPhone',
  facets: {
    categories: [{ id: 'cat-phones', name: 'Smartphones', count: 1 }],
    brands: [{ name: 'Apple', count: 1 }],
    merchants: [{ id: 'merchant-beta', name: 'Beta Retail', count: 1 }],
    priceRange: { min: 9500000, max: 10000000 },
  },
};

describe('SearchPage Frontend Integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders search input and displays search results from searchApi', async () => {
    vi.spyOn(searchApi, 'search').mockResolvedValue(mockSearchResponse);

    render(
      <MemoryRouter initialEntries={['/search?q=iPhone']}>
        <Routes>
          <Route path="/search" element={<SearchPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: /search products/i })).toBeDefined();

    // Verify searchApi was invoked
    await waitFor(() => {
      expect(searchApi.search).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'iPhone' }),
      );
    });

    // Check product title, category, and offer count
    await waitFor(() => {
      expect(screen.getByText('Apple iPhone 15 Pro')).toBeDefined();
      expect(screen.getByText('In Smartphones')).toBeDefined();
      expect(screen.getByText('2 seller offers')).toBeDefined();
      expect(screen.getByText('In Stock')).toBeDefined();
    });
  });

  it('renders empty state when no products match the query', async () => {
    vi.spyOn(searchApi, 'search').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 12,
      totalPages: 0,
      facets: { categories: [], brands: [], merchants: [], priceRange: { min: 0, max: 0 } },
    });

    render(
      <MemoryRouter initialEntries={['/search?q=UnknownDevice']}>
        <Routes>
          <Route path="/search" element={<SearchPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('No products found')).toBeDefined();
      expect(screen.getByRole('button', { name: /reset all filters/i })).toBeDefined();
    });
  });

  it('renders error state when searchApi fails', async () => {
    vi.spyOn(searchApi, 'search').mockRejectedValue(new Error('Search service unreachable'));

    render(
      <MemoryRouter initialEntries={['/search']}>
        <Routes>
          <Route path="/search" element={<SearchPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
      expect(screen.getByText(/Search service unreachable/i)).toBeDefined();
    });
  });

  it('allows user to type in query and submit search form', async () => {
    const searchSpy = vi.spyOn(searchApi, 'search').mockResolvedValue(mockSearchResponse);

    render(
      <MemoryRouter initialEntries={['/search']}>
        <Routes>
          <Route path="/search" element={<SearchPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // Wait for initial load to complete
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^search$/i })).toBeDefined();
    });

    const input = screen.getByLabelText(/search products/i);
    fireEvent.change(input, { target: { value: 'Samsung' } });
    const submitBtn = screen.getByRole('button', { name: /^search$/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(searchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'Samsung' }),
      );
    });
  });
});
