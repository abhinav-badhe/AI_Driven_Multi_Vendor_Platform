import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProductPage } from '../src/features/catalog/Product';
import {
  catalogApi,
  type ProductReview,
  type ProductRatingSummary,
} from '../src/features/catalog/api/catalog';

vi.mock('../src/features/catalog/api/catalog', () => ({
  catalogApi: {
    getProduct: vi.fn(),
    getProductSkus: vi.fn(),
    getProductReviews: vi.fn(),
    getProductRatingSummary: vi.fn(),
    getReviewEligibility: vi.fn(),
    submitReview: vi.fn(),
    updateReview: vi.fn(),
    deleteReview: vi.fn(),
    getCustomerReviews: vi.fn(),
    recordView: vi.fn().mockResolvedValue({ tracked: true }),
  },
}));

vi.mock('../src/features/marketplace/api/marketplace', () => ({
  marketplaceApi: {
    getSkuListings: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../src/features/cart/CartContext', () => ({
  useCart: () => ({
    addItem: vi.fn(),
  }),
}));

let mockCurrentUser: { userId: string; email: string; role: string; tenantId: string } | null = {
  userId: 'user-123',
  email: 'customer@example.com',
  role: 'CUSTOMER',
  tenantId: 'tenant-123',
};

vi.mock('../src/features/auth/AuthContext', () => ({
  useAuth: () => ({
    user: mockCurrentUser,
    isAuthenticated: Boolean(mockCurrentUser),
    login: vi.fn(),
  }),
}));

const mockProduct = {
  id: 'prod-100',
  title: 'Wireless Studio Headphones',
  slug: 'wireless-studio-headphones',
  description: 'Premium headphones with active noise cancellation.',
  brand: 'AudioPhile',
  categoryId: 'cat-1',
  status: 'ACTIVE' as const,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const mockRatingSummary: ProductRatingSummary = {
  productId: 'prod-100',
  averageRating: 4.5,
  totalReviews: 2,
  distribution: {
    5: 1,
    4: 1,
    3: 0,
    2: 0,
    1: 0,
  },
};

const mockApprovedReviews: ProductReview[] = [
  {
    id: 'rev-1',
    productId: 'prod-100',
    customerId: 'user-other',
    rating: 5,
    title: 'Incredible soundstage',
    comment: 'The noise cancellation is sublime and battery lasts for days.',
    reviewerName: 'Alice',
    status: 'APPROVED',
    verifiedPurchase: true,
    reviewedAt: '2026-02-01T12:00:00Z',
    createdAt: '2026-02-01T12:00:00Z',
  },
  {
    id: 'rev-2',
    productId: 'prod-100',
    customerId: 'user-123',
    rating: 4,
    title: 'Very comfortable',
    comment: 'A bit heavy after 4 hours, but audio quality makes up for it.',
    reviewerName: 'customer',
    status: 'APPROVED',
    verifiedPurchase: true,
    reviewedAt: '2026-02-05T12:00:00Z',
    createdAt: '2026-02-05T12:00:00Z',
  },
];

describe('Customer Product Reviews & Moderation Frontend Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentUser = {
      userId: 'user-123',
      email: 'customer@example.com',
      role: 'CUSTOMER',
      tenantId: 'tenant-123',
    };

    vi.mocked(catalogApi.getProduct).mockResolvedValue(mockProduct);
    vi.mocked(catalogApi.getProductSkus).mockResolvedValue([]);
    vi.mocked(catalogApi.getProductReviews).mockResolvedValue(mockApprovedReviews);
    vi.mocked(catalogApi.getProductRatingSummary).mockResolvedValue(mockRatingSummary);
    vi.mocked(catalogApi.getReviewEligibility).mockResolvedValue({
      hasPurchased: true,
      alreadyReviewed: false,
      isEligible: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  const renderProductPage = () => {
    return render(
      <MemoryRouter initialEntries={['/product/prod-100']}>
        <Routes>
          <Route path="/product/:id" element={<ProductPage />} />
        </Routes>
      </MemoryRouter>,
    );
  };

  it('1. Rating Display: renders average rating and 5-to-1 star distribution bars', async () => {
    renderProductPage();

    await waitFor(() => {
      expect(screen.getByTestId('average-rating').textContent).toContain('4.5');
      expect(screen.getByTestId('total-reviews-count').textContent).toContain('2 verified reviews');
    });

    const distribution = screen.getByTestId('rating-distribution');
    expect(distribution.textContent).toContain('5 star');
    expect(distribution.textContent).toContain('4 star');
    expect(distribution.textContent).toContain('3 star');
    expect(distribution.textContent).toContain('2 star');
    expect(distribution.textContent).toContain('1 star');
  });

  it('2. Review List: renders approved reviews with verified purchase badge, stars, and comment', async () => {
    renderProductPage();

    await waitFor(() => {
      expect(screen.getByText('Incredible soundstage')).toBeDefined();
      expect(screen.getByText('Very comfortable')).toBeDefined();
      expect(screen.getAllByText('Verified Purchase').length).toBe(2);
    });

    expect(screen.getByText(/The noise cancellation is sublime/i)).toBeDefined();
    expect(screen.getByText(/— Alice/i)).toBeDefined();
  });

  it('3. Empty State: renders empty review state when a product has 0 reviews', async () => {
    vi.mocked(catalogApi.getProductReviews).mockResolvedValue([]);
    vi.mocked(catalogApi.getProductRatingSummary).mockResolvedValue({
      productId: 'prod-100',
      averageRating: 0,
      totalReviews: 0,
      distribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
    });

    renderProductPage();

    await waitFor(() => {
      expect(screen.getByTestId('empty-reviews').textContent).toContain('No customer reviews yet');
    });
  });

  it('4. Verified Purchase Restriction: shows verified purchase notice if customer has not purchased', async () => {
    vi.mocked(catalogApi.getReviewEligibility).mockResolvedValue({
      hasPurchased: false,
      alreadyReviewed: false,
      isEligible: false,
    });

    renderProductPage();

    await waitFor(() => {
      expect(screen.getByTestId('verified-purchase-restriction')).toBeDefined();
      expect(screen.getByText(/Verified purchase required/i)).toBeDefined();
    });

    // "Write a Review" button should not be present
    expect(screen.queryByTestId('write-review-button')).toBeNull();
  });

  it('5. Write-Review Form & Validation: validates minimum comment length', async () => {
    renderProductPage();

    await waitFor(() => {
      expect(screen.getByText('Write a Review')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Write a Review'));

    expect(screen.getByTestId('write-review-form')).toBeDefined();

    // Fill in a comment with fewer than 3 characters
    const commentInput = screen.getByTestId('review-comment-input');
    fireEvent.change(commentInput, { target: { value: 'Hi' } });

    fireEvent.click(screen.getByTestId('submit-review-button'));

    await waitFor(() => {
      expect(screen.getByText(/Review comment must be at least 3 characters long/i)).toBeDefined();
    });

    expect(catalogApi.submitReview).not.toHaveBeenCalled();
  });

  it('6. Review Submission: submits valid review, calls API, and renders success notification', async () => {
    vi.mocked(catalogApi.submitReview).mockResolvedValue({
      id: 'rev-new',
      productId: 'prod-100',
      rating: 5,
      title: 'Flawless performance',
      comment: 'Top quality materials and pristine sound.',
      status: 'PENDING',
      verifiedPurchase: true,
      createdAt: new Date().toISOString(),
    });

    renderProductPage();

    await waitFor(() => {
      expect(screen.getByText('Write a Review')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Write a Review'));

    // Select 5 stars
    fireEvent.click(screen.getByTestId('rating-star-5'));

    // Enter title & comment
    fireEvent.change(screen.getByTestId('review-title-input'), {
      target: { value: 'Flawless performance' },
    });
    fireEvent.change(screen.getByTestId('review-comment-input'), {
      target: { value: 'Top quality materials and pristine sound.' },
    });

    fireEvent.click(screen.getByTestId('submit-review-button'));

    await waitFor(() => {
      expect(catalogApi.submitReview).toHaveBeenCalledWith('prod-100', {
        rating: 5,
        title: 'Flawless performance',
        comment: 'Top quality materials and pristine sound.',
      });
      expect(screen.getByText(/Your review has been submitted for moderation/i)).toBeDefined();
    });
  });

  it('7. Moderation / Status Display: displays Pending Moderation badge for pending review', async () => {
    const pendingReview: ProductReview = {
      id: 'rev-pending',
      productId: 'prod-100',
      customerId: 'user-123',
      rating: 5,
      title: 'Awaiting approval',
      comment: 'Just submitted this new review.',
      reviewerName: 'customer',
      status: 'PENDING',
      verifiedPurchase: true,
      createdAt: new Date().toISOString(),
    };

    vi.mocked(catalogApi.getProductReviews).mockResolvedValue([pendingReview]);

    renderProductPage();

    await waitFor(() => {
      expect(screen.getByText('Pending Moderation')).toBeDefined();
    });
  });

  it('8. Customer Review Management: allows author to edit and delete own review', async () => {
    window.confirm = vi.fn().mockReturnValue(true);
    vi.mocked(catalogApi.deleteReview).mockResolvedValue(undefined);

    renderProductPage();

    await waitFor(() => {
      expect(screen.getByText('Very comfortable')).toBeDefined();
    });

    // Author's review has Edit and Delete buttons
    const editBtn = screen.getByLabelText('Edit review');
    const deleteBtn = screen.getByLabelText('Delete review');
    expect(editBtn).toBeDefined();
    expect(deleteBtn).toBeDefined();

    // Click Delete
    fireEvent.click(deleteBtn);
    expect(window.confirm).toHaveBeenCalled();
    expect(catalogApi.deleteReview).toHaveBeenCalledWith('rev-2');

    // Click Edit
    fireEvent.click(editBtn);
    expect(screen.getByTestId('write-review-form')).toBeDefined();
    expect((screen.getByTestId('review-title-input') as HTMLInputElement).value).toBe(
      'Very comfortable',
    );
  });
});
