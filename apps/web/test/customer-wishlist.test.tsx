import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { BrowserRouter, MemoryRouter, Route, Routes } from 'react-router-dom';
import { WishlistPage } from '../src/features/customer/WishlistPage';
import { wishlistApi, type WishlistItem } from '../src/features/customer/api/wishlist';
import { ProductPage } from '../src/features/catalog/Product';
import { catalogApi } from '../src/features/catalog/api/catalog';

vi.mock('../src/features/customer/api/wishlist', () => ({
  wishlistApi: {
    getWishlist: vi.fn(),
    addToWishlist: vi.fn(),
    removeFromWishlist: vi.fn(),
    checkWishlist: vi.fn(),
    saveForLater: vi.fn(),
    moveToCart: vi.fn(),
  },
}));

const mockRefreshCart = vi.fn();
const mockAddItem = vi.fn();
vi.mock('../src/features/cart/CartContext', () => ({
  useCart: () => ({
    refreshCart: mockRefreshCart,
    addItem: mockAddItem,
    itemCount: 2,
    cart: { items: [], itemCount: 0, subtotalAmount: 0 },
  }),
  CartProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

let mockIsAuthenticated = true;
const mockLogin = vi.fn();
vi.mock('../src/features/auth/AuthContext', () => ({
  useAuth: () => ({
    isAuthenticated: mockIsAuthenticated,
    user: mockIsAuthenticated ? { userId: 'cust-1', email: 'test@customer.com', role: 'CUSTOMER' } : null,
    login: mockLogin,
    logout: vi.fn(),
    isLoading: false,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../src/features/catalog/api/catalog', () => ({
  catalogApi: {
    getProduct: vi.fn(),
    getProductSkus: vi.fn(),
    getProductReviews: vi.fn().mockResolvedValue([]),
    getProductRatingSummary: vi.fn().mockResolvedValue(null),
    getReviewEligibility: vi.fn().mockResolvedValue({ eligible: false }),
    recordView: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../src/features/marketplace/api/marketplace', () => ({
  marketplaceApi: {
    getProductListings: vi.fn().mockResolvedValue([]),
    getListingsBySku: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../src/features/recommendations/api/recommendations', () => ({
  recommendationsApi: {
    getSimilarProducts: vi.fn().mockResolvedValue([]),
  },
}));

const mockWishlistItems: WishlistItem[] = [
  {
    id: 'wish-1',
    customerId: 'cust-1',
    tenantId: 'cust-tenant-1',
    productId: 'prod-1',
    skuId: 'sku-1',
    product: {
      id: 'prod-1',
      title: 'Ergonomic Office Chair',
      slug: 'ergonomic-office-chair',
      brand: 'ComfortCo',
      thumbnailUrl: 'https://example.com/chair.jpg',
      images: ['https://example.com/chair.jpg'],
      status: 'ACTIVE',
      rating: 4.8,
      reviewCount: 42,
    },
    sku: {
      id: 'sku-1',
      skuCode: 'CHAIR-BLK-01',
      attributes: { color: 'Black' },
    },
    offer: {
      listingId: 'list-1',
      merchantTenantId: 'merch-alpha',
      priceAmount: 14999,
      currency: 'INR',
      compareAtPrice: 17999,
    },
    availability: {
      isAvailable: true,
      availableQuantity: 15,
      status: 'IN_STOCK',
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'wish-2',
    customerId: 'cust-1',
    tenantId: 'cust-tenant-1',
    productId: 'prod-2',
    skuId: null,
    product: {
      id: 'prod-2',
      title: 'Mechanical Keyboard RGB',
      slug: 'mechanical-keyboard-rgb',
      brand: 'KeyMaster',
      thumbnailUrl: null,
      images: [],
      status: 'ACTIVE',
      rating: 4.5,
      reviewCount: 18,
    },
    sku: null,
    offer: null,
    availability: {
      isAvailable: false,
      availableQuantity: 0,
      status: 'OUT_OF_STOCK',
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

describe('Customer Wishlist Frontend Experience', () => {
  beforeEach(() => {
    mockIsAuthenticated = true;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('1. Renders Wishlist Page with wishlisted items and current offer details', async () => {
    vi.mocked(wishlistApi.getWishlist).mockResolvedValue(mockWishlistItems);

    render(
      <BrowserRouter>
        <WishlistPage />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/My Wishlist \(2 items\)/i)).toBeDefined();
      expect(screen.getByText('Ergonomic Office Chair')).toBeDefined();
      expect(screen.getByText('Mechanical Keyboard RGB')).toBeDefined();
      expect(screen.getByText('ComfortCo')).toBeDefined();
      expect(screen.getByText('CHAIR-BLK-01')).toBeDefined();
      expect(screen.getByText('In Stock')).toBeDefined();
      expect(screen.getByText('Out of Stock')).toBeDefined();
    });
  });

  it('2. Renders empty state when wishlist has no items', async () => {
    vi.mocked(wishlistApi.getWishlist).mockResolvedValue([]);

    render(
      <BrowserRouter>
        <WishlistPage />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Your wishlist is empty/i)).toBeDefined();
      expect(screen.getByText(/Browse products/i)).toBeDefined();
    });
  });

  it('3. Renders login prompt when user is unauthenticated', async () => {
    mockIsAuthenticated = false;

    render(
      <BrowserRouter>
        <WishlistPage />
      </BrowserRouter>,
    );

    expect(screen.getByText(/Sign in to view items saved for later/i)).toBeDefined();
    expect(screen.getByText('Sign in')).toBeDefined();
  });

  it('4. Handles Move to Cart flow on Wishlist Page', async () => {
    vi.mocked(wishlistApi.getWishlist).mockResolvedValue(mockWishlistItems);
    vi.mocked(wishlistApi.moveToCart).mockResolvedValue({
      cart: { id: 'c-1', tenantId: 't-1', status: 'ACTIVE', items: [], itemCount: 1, subtotalAmount: 14999, currency: 'INR', createdAt: '', updatedAt: '' },
      message: 'Moved to cart',
    });

    render(
      <BrowserRouter>
        <WishlistPage />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Ergonomic Office Chair')).toBeDefined();
    });

    const moveBtns = screen.getAllByRole('button', { name: /Move to Cart/i });
    fireEvent.click(moveBtns[0]!);

    await waitFor(() => {
      expect(wishlistApi.moveToCart).toHaveBeenCalledWith('prod-1', 'list-1');
      expect(mockRefreshCart).toHaveBeenCalled();
      expect(screen.getByText(/"Ergonomic Office Chair" moved to your shopping cart\./i)).toBeDefined();
    });
  });

  it('5. Handles Remove item flow on Wishlist Page', async () => {
    vi.mocked(wishlistApi.getWishlist).mockResolvedValue(mockWishlistItems);
    vi.mocked(wishlistApi.removeFromWishlist).mockResolvedValue();

    render(
      <BrowserRouter>
        <WishlistPage />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Ergonomic Office Chair')).toBeDefined();
    });

    const removeBtns = screen.getAllByRole('button', { name: /Remove/i });
    fireEvent.click(removeBtns[0]!);

    await waitFor(() => {
      expect(wishlistApi.removeFromWishlist).toHaveBeenCalledWith('prod-1');
      expect(screen.getByText(/"Ergonomic Office Chair" removed from your wishlist\./i)).toBeDefined();
    });
  });

  it('6. Shows error alert when wishlist API fails', async () => {
    vi.mocked(wishlistApi.getWishlist).mockRejectedValue(new Error('Network connectivity lost'));

    render(
      <BrowserRouter>
        <WishlistPage />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Wishlist operation failed/i)).toBeDefined();
      expect(screen.getByText(/Network connectivity lost/i)).toBeDefined();
    });
  });

  it('7. Product Page renders Wishlist button and toggles wishlist status', async () => {
    vi.mocked(catalogApi.getProduct).mockResolvedValue({
      id: 'prod-1',
      title: 'Ergonomic Office Chair',
      slug: 'ergonomic-office-chair',
      description: 'Comfortable ergonomic office chair',
      brand: 'ComfortCo',
      categoryId: 'cat-1',
      status: 'ACTIVE',
      images: [],
      reviewCount: 0,
      attributes: {},
      createdAt: '',
      updatedAt: '',
    });
    vi.mocked(catalogApi.getProductSkus).mockResolvedValue([
      { id: 'sku-1', productId: 'prod-1', skuCode: 'CHAIR-BLK-01', barcode: 'CHAIR-123', status: 'ACTIVE', attributes: {}, createdAt: '', updatedAt: '' },
    ]);
    vi.mocked(catalogApi.getProductReviews).mockResolvedValue([]);
    vi.mocked(catalogApi.getProductRatingSummary).mockResolvedValue(null);
    vi.mocked(wishlistApi.checkWishlist).mockResolvedValue({ isWishlisted: false, wishlistItemId: null });
    vi.mocked(wishlistApi.addToWishlist).mockResolvedValue(mockWishlistItems[0]!);

    render(
      <MemoryRouter initialEntries={['/product/prod-1']}>
        <Routes>
          <Route path="/product/:id" element={<ProductPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Ergonomic Office Chair')).toBeDefined();
      expect(screen.getByRole('button', { name: /Save to Wishlist/i })).toBeDefined();
    });

    const wishlistBtn = screen.getByRole('button', { name: /Save to Wishlist/i });
    fireEvent.click(wishlistBtn);

    await waitFor(() => {
      expect(wishlistApi.addToWishlist).toHaveBeenCalledWith('prod-1', 'sku-1');
      expect(screen.getByRole('button', { name: /In Wishlist/i })).toBeDefined();
    });
  });
});
