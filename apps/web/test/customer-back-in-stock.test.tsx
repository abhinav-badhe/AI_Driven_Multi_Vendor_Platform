import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProductPage } from '../src/features/catalog/Product';
import { WishlistPage } from '../src/features/customer/WishlistPage';
import { AccountPage } from '../src/features/auth/AccountPage';
import { backInStockApi } from '../src/features/customer/api/back-in-stock';
import { wishlistApi } from '../src/features/customer/api/wishlist';
import { catalogApi } from '../src/features/catalog/api/catalog';
import { marketplaceApi } from '../src/features/marketplace/api/marketplace';
import { recommendationsApi } from '../src/features/recommendations/api/recommendations';

// Mock backInStockApi
vi.mock('../src/features/customer/api/back-in-stock', () => ({
  backInStockApi: {
    getSubscriptions: vi.fn(),
    subscribe: vi.fn(),
    cancelSubscription: vi.fn(),
    checkSubscription: vi.fn(),
  },
}));

// Mock wishlistApi
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

// Mock CartContext
const mockRefreshCart = vi.fn();
const mockAddItem = vi.fn();
vi.mock('../src/features/cart/CartContext', () => ({
  useCart: () => ({
    refreshCart: mockRefreshCart,
    addItem: mockAddItem,
    itemCount: 0,
    cart: { items: [], itemCount: 0, subtotalAmount: 0 },
  }),
  CartProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock AuthContext
let mockIsAuthenticated = true;
const mockLogin = vi.fn();
vi.mock('../src/features/auth/AuthContext', () => ({
  useAuth: () => ({
    isAuthenticated: mockIsAuthenticated,
    user: mockIsAuthenticated
      ? { userId: 'cust-1', email: 'test@customer.com', role: 'CUSTOMER', tenantId: 'cust-tenant' }
      : null,
    login: mockLogin,
    logout: vi.fn(),
    isLoading: false,
    register: vi.fn(),
    resendVerification: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  isEmailNotVerifiedError: () => false,
}));

// Mock catalogApi
vi.mock('../src/features/catalog/api/catalog', () => ({
  catalogApi: {
    getProduct: vi.fn(),
    getProductSkus: vi.fn(),
    getProductReviews: vi.fn().mockResolvedValue([]),
    getProductRatingSummary: vi.fn().mockResolvedValue(null),
    getReviewEligibility: vi.fn().mockResolvedValue({ isEligible: false }),
    recordView: vi.fn().mockResolvedValue({}),
  },
}));

// Mock marketplaceApi
vi.mock('../src/features/marketplace/api/marketplace', () => ({
  marketplaceApi: {
    getSkuListings: vi.fn(),
  },
}));

// Mock recommendationsApi
vi.mock('../src/features/recommendations/api/recommendations', () => ({
  recommendationsApi: {
    getSimilar: vi.fn().mockResolvedValue({ items: [] }),
  },
}));

describe('Customer Back-in-Stock Alerts (Frontend UI)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAuthenticated = true;
    (catalogApi.getProduct as any).mockResolvedValue({
      id: 'prod-out',
      title: 'Sold Out Ultra Watch',
      slug: 'sold-out-ultra-watch',
      brand: 'Titan',
      status: 'ACTIVE',
      images: ['https://example.com/watch.jpg'],
      rating: 4.5,
      reviewCount: 12,
    });
    (catalogApi.getProductSkus as any).mockResolvedValue([
      { id: 'sku-out-1', skuCode: 'WATCH-BLK-1', attributes: { color: 'Black' } },
    ]);
    (wishlistApi.checkWishlist as any).mockResolvedValue({ isWishlisted: false });
    (backInStockApi.checkSubscription as any).mockResolvedValue({
      isSubscribed: false,
      status: null,
    });
    (marketplaceApi.getSkuListings as any).mockResolvedValue([]);
    (catalogApi.getProductReviews as any).mockResolvedValue([]);
    (catalogApi.getProductRatingSummary as any).mockResolvedValue(null);
    (catalogApi.getReviewEligibility as any).mockResolvedValue({ isEligible: false });
    (recommendationsApi.getSimilar as any).mockResolvedValue({ items: [] });
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('1. Out of stock / unavailable product displays Out of Stock badge and Notify Me button', async () => {
    (marketplaceApi.getSkuListings as any).mockResolvedValue([]); // No merchant listings = Out of Stock

    render(
      <MemoryRouter initialEntries={['/product/prod-out']}>
        <Routes>
          <Route path="/product/:id" element={<ProductPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Out of Stock')).toBeInTheDocument();
      const notifyBtn = screen.getByTestId('notify-me-button');
      expect(notifyBtn).toBeInTheDocument();
      expect(notifyBtn).toHaveTextContent('Notify me when available');
    });
  });

  it('2. Already-in-stock product with listings does NOT show Notify Me button', async () => {
    (marketplaceApi.getSkuListings as any).mockResolvedValue([
      {
        id: 'list-1',
        skuId: 'sku-out-1',
        tenantId: 'merchant-1',
        priceAmount: 4999,
        currency: 'INR',
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/product/prod-out']}>
        <Routes>
          <Route path="/product/:id" element={<ProductPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('49.99 INR')).toBeInTheDocument();
    });

    // Listings rail shows merchant offer and does NOT show Notify Me button
    expect(screen.queryByTestId('notify-me-button')).not.toBeInTheDocument();
    expect(screen.queryByText('Out of Stock')).not.toBeInTheDocument();
  });

  it('3. Authenticated customer can subscribe: clicking Notify Me updates UI to subscribed state', async () => {
    (marketplaceApi.getSkuListings as any).mockResolvedValue([]);
    (backInStockApi.subscribe as any).mockResolvedValue({
      id: 'sub-1',
      productId: 'prod-out',
      skuId: 'sku-out-1',
      status: 'ACTIVE',
    });

    render(
      <MemoryRouter initialEntries={['/product/prod-out']}>
        <Routes>
          <Route path="/product/:id" element={<ProductPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.queryByLabelText('Loading offers')).not.toBeInTheDocument();
      expect(screen.getByTestId('notify-me-button')).toBeInTheDocument();
    });

    const notifyBtn = screen.getByTestId('notify-me-button');
    fireEvent.click(notifyBtn);

    await waitFor(() => {
      expect(backInStockApi.subscribe).toHaveBeenCalledWith('prod-out', 'sku-out-1');
      expect(screen.getByTestId('stock-subscribed-message')).toHaveTextContent(
        "You'll be notified when this product is back in stock.",
      );
      expect(screen.getByTestId('cancel-notification-button')).toBeInTheDocument();
    });
  });

  it('4. Subscribed customer can cancel notification from product page', async () => {
    (marketplaceApi.getSkuListings as any).mockResolvedValue([]);
    (backInStockApi.checkSubscription as any).mockResolvedValue({
      isSubscribed: true,
      status: 'ACTIVE',
      subscriptionId: 'sub-1',
    });
    (backInStockApi.cancelSubscription as any).mockResolvedValue({
      success: true,
      message: 'Subscription cancelled',
    });

    render(
      <MemoryRouter initialEntries={['/product/prod-out']}>
        <Routes>
          <Route path="/product/:id" element={<ProductPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const cancelBtn = await screen.findByTestId('cancel-notification-button');
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(backInStockApi.cancelSubscription).toHaveBeenCalledWith('prod-out');
      expect(screen.getByTestId('notify-me-button')).toBeInTheDocument();
    });
  });

  it('5. Unauthenticated user clicking Notify Me invokes login flow', async () => {
    mockIsAuthenticated = false;
    (marketplaceApi.getSkuListings as any).mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={['/product/prod-out']}>
        <Routes>
          <Route path="/product/:id" element={<ProductPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const notifyBtn = await screen.findByTestId('notify-me-button');
    fireEvent.click(notifyBtn);

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalled();
      expect(backInStockApi.subscribe).not.toHaveBeenCalled();
    });
  });

  it('6. Error state displays error message when subscription fails', async () => {
    (marketplaceApi.getSkuListings as any).mockResolvedValue([]);
    (backInStockApi.subscribe as any).mockRejectedValue(new Error('Network error subscribing'));

    render(
      <MemoryRouter initialEntries={['/product/prod-out']}>
        <Routes>
          <Route path="/product/:id" element={<ProductPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const notifyBtn = await screen.findByTestId('notify-me-button');
    fireEvent.click(notifyBtn);

    await waitFor(() => {
      expect(screen.getByTestId('stock-sub-error')).toHaveTextContent('Network error subscribing');
    });
  });

  it('7. Wishlist integration: unavailable item allows toggling back-in-stock notification', async () => {
    (wishlistApi.getWishlist as any).mockResolvedValue([
      {
        id: 'wish-1',
        customerId: 'cust-1',
        tenantId: 'cust-tenant',
        productId: 'prod-out',
        skuId: 'sku-out-1',
        product: {
          id: 'prod-out',
          title: 'Sold Out Ultra Watch',
          slug: 'sold-out-ultra-watch',
        },
        availability: {
          isAvailable: false,
          availableQuantity: 0,
          status: 'OUT_OF_STOCK',
        },
        offer: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    (backInStockApi.getSubscriptions as any).mockResolvedValue([]);
    (backInStockApi.subscribe as any).mockResolvedValue({
      id: 'sub-wish-1',
      productId: 'prod-out',
      status: 'ACTIVE',
    });

    render(
      <MemoryRouter>
        <WishlistPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Sold Out Ultra Watch')).toBeInTheDocument();
    });

    const alertBtn = screen.getByTestId('stock-alert-button-prod-out');
    expect(alertBtn).toBeInTheDocument();
    expect(alertBtn).toHaveTextContent('Notify Me');

    fireEvent.click(alertBtn);

    await waitFor(() => {
      expect(backInStockApi.subscribe).toHaveBeenCalledWith('prod-out', 'sku-out-1');
      expect(alertBtn).toHaveTextContent('Alert Active');
    });
  });

  it('8. Customer Account page displays stock alerts and allows cancellation', async () => {
    (backInStockApi.getSubscriptions as any).mockResolvedValue([
      {
        id: 'sub-acc-1',
        customerId: 'cust-1',
        tenantId: 'cust-tenant',
        productId: 'prod-out',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        product: {
          id: 'prod-out',
          title: 'Sold Out Ultra Watch',
          slug: 'sold-out-ultra-watch',
        },
      },
    ]);
    (backInStockApi.cancelSubscription as any).mockResolvedValue({
      success: true,
      message: 'Cancelled',
    });

    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('My Account')).toBeInTheDocument();
    });

    // Click Stock Alerts tab
    const alertsTab = screen.getByRole('tab', { name: /Stock Alerts/i });
    expect(alertsTab).toBeInTheDocument();
    fireEvent.click(alertsTab);

    await waitFor(() => {
      expect(screen.getByText('Sold Out Ultra Watch')).toBeInTheDocument();
      expect(screen.getByTestId('cancel-alert-prod-out')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('cancel-alert-prod-out'));

    await waitFor(() => {
      expect(backInStockApi.cancelSubscription).toHaveBeenCalledWith('prod-out');
      expect(screen.getByText('Stock alert cancelled.')).toBeInTheDocument();
    });
  });
});
