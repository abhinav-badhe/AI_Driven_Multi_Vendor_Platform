import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { BrowserRouter } from 'react-router-dom';
import { CheckoutPage } from '../src/features/checkout/CheckoutPage';
import { checkoutApi } from '../src/features/checkout/api/checkout';

vi.mock('../src/features/checkout/api/checkout', () => ({
  checkoutApi: {
    createSession: vi.fn(),
    reserveInventory: vi.fn(),
    createPaymentIntent: vi.fn(),
    submitPaymentAttempt: vi.fn(),
    finalizeOrder: vi.fn(),
    getPaymentConfig: vi.fn().mockResolvedValue({
      provider: 'razorpay',
      razorpayKeyId: 'rzp_test_mockKey123',
      currency: 'INR',
    }),
  },
}));

vi.mock('../src/features/cart/CartContext', () => ({
  useCart: () => ({
    refreshCart: vi.fn(),
  }),
  CartProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('CheckoutPage Browser Payment & 3DS SCA State Handling', () => {
  const mockSession = {
    id: 'chk-session-123',
    cartId: 'cart-1',
    customerTenantId: 'cust-tenant-1',
    status: 'READY' as const,
    currency: 'USD',
    subtotalAmount: 99.99,
    discountAmount: 0,
    shippingAmount: 0,
    taxAmount: 0,
    totalAmount: 99.99,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    items: [
      {
        id: 'item-1',
        checkoutSessionId: 'chk-session-123',
        listingId: 'list-1',
        skuId: 'sku-1',
        merchantTenantId: 'merch-1',
        productTitle: 'Premium Headphones',
        quantity: 1,
        unitPriceAmount: 99.99,
        lineTotalAmount: 99.99,
        currency: 'USD',
        createdAt: new Date().toISOString(),
      },
    ],
    createdAt: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkoutApi.createSession).mockResolvedValue(mockSession);
    vi.mocked(checkoutApi.reserveInventory).mockResolvedValue(mockSession);
    vi.mocked(checkoutApi.createPaymentIntent).mockResolvedValue({
      id: 'pi-123',
      customerTenantId: 'cust-tenant-1',
      checkoutSessionId: 'chk-session-123',
      orderId: null,
      amount: 99.99,
      currency: 'USD',
      status: 'CREATED',
      provider: 'stripe',
      clientSecret: 'pi_123_secret_xyz',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('completes successful browser payment flow (SUCCEEDED)', async () => {
    vi.mocked(checkoutApi.submitPaymentAttempt).mockResolvedValue({
      id: 'att-succ-1',
      paymentIntentId: 'pi-123',
      provider: 'stripe',
      providerTransactionId: 'txn_123',
      amount: 99.99,
      currency: 'USD',
      status: 'SUCCEEDED',
      failureCode: null,
      failureMessage: null,
    });

    vi.mocked(checkoutApi.finalizeOrder).mockResolvedValue({
      id: 'order-123',
      orderNumber: 'ORD-9999',
      customerTenantId: 'cust-tenant-1',
      status: 'PAID',
      totalAmount: 99.99,
      currency: 'USD',
      createdAt: new Date().toISOString(),
    });

    render(
      <BrowserRouter>
        <CheckoutPage />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Premium Headphones')).toBeDefined();
    });

    // Fill delivery form
    fireEvent.change(screen.getByLabelText(/Full name/i), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText(/Street address/i), { target: { value: '123 Market St' } });
    fireEvent.change(screen.getByLabelText(/City/i), { target: { value: 'San Francisco' } });
    fireEvent.change(screen.getByLabelText(/PIN code/i), { target: { value: '94105' } });

    // Submit payment
    fireEvent.submit(screen.getByRole('button', { name: /Pay/i }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByText(/Order confirmed/i)).toBeDefined();
      expect(screen.getByText('ORD-9999')).toBeDefined();
    });
  });

  it('displays gateway decline error with Retry Payment button on payment failure (FAILED)', async () => {
    vi.mocked(checkoutApi.submitPaymentAttempt).mockResolvedValue({
      id: 'att-fail-1',
      paymentIntentId: 'pi-123',
      provider: 'stripe',
      providerTransactionId: 'txn_fail',
      amount: 99.99,
      currency: 'USD',
      status: 'FAILED',
      failureCode: 'card_declined',
      failureMessage: 'Your card was declined by the issuing bank.',
    });

    render(
      <BrowserRouter>
        <CheckoutPage />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Premium Headphones')).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText(/Full name/i), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText(/Street address/i), { target: { value: '123 Market St' } });
    fireEvent.change(screen.getByLabelText(/City/i), { target: { value: 'San Francisco' } });
    fireEvent.change(screen.getByLabelText(/PIN code/i), { target: { value: '94105' } });

    fireEvent.submit(screen.getByRole('button', { name: /Pay/i }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByText(/Your card was declined by the issuing bank\./i)).toBeDefined();
      expect(screen.getByRole('button', { name: /Retry Payment/i })).toBeDefined();
    });
  });

  it('handles REQUIRES_ACTION with 3D Secure modal and authorizes successfully', async () => {
    // 1st attempt triggers REQUIRES_ACTION
    vi.mocked(checkoutApi.submitPaymentAttempt).mockResolvedValueOnce({
      id: 'att-act-1',
      paymentIntentId: 'pi-123',
      provider: 'stripe',
      providerTransactionId: 'txn_act_1',
      amount: 99.99,
      currency: 'USD',
      status: 'REQUIRES_ACTION',
      failureCode: 'requires_action',
      failureMessage: 'Cardholder action required (3DS / SCA)',
    });

    // 2nd attempt (authorized in modal) succeeds
    vi.mocked(checkoutApi.submitPaymentAttempt).mockResolvedValueOnce({
      id: 'att-act-2',
      paymentIntentId: 'pi-123',
      provider: 'stripe',
      providerTransactionId: 'txn_act_2',
      amount: 99.99,
      currency: 'USD',
      status: 'SUCCEEDED',
      failureCode: null,
      failureMessage: null,
    });

    vi.mocked(checkoutApi.finalizeOrder).mockResolvedValue({
      id: 'order-3ds',
      orderNumber: 'ORD-3DS-PASS',
      customerTenantId: 'cust-tenant-1',
      status: 'PAID',
      totalAmount: 99.99,
      currency: 'USD',
      createdAt: new Date().toISOString(),
    });

    render(
      <BrowserRouter>
        <CheckoutPage />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Premium Headphones')).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText(/Full name/i), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText(/Street address/i), { target: { value: '123 Market St' } });
    fireEvent.change(screen.getByLabelText(/City/i), { target: { value: 'San Francisco' } });
    fireEvent.change(screen.getByLabelText(/PIN code/i), { target: { value: '94105' } });

    fireEvent.submit(screen.getByRole('button', { name: /Pay/i }).closest('form')!);

    // Verify 3D-Secure modal renders
    await waitFor(() => {
      expect(screen.getByText(/3D Secure Authentication/i)).toBeDefined();
      expect(screen.getByText(/Strong Customer Authentication \(SCA\)/i)).toBeDefined();
    });

    // Authorize payment in 3DS challenge modal
    fireEvent.click(screen.getByRole('button', { name: /Authorize & Complete Payment/i }));

    await waitFor(() => {
      expect(screen.getByText(/Order confirmed/i)).toBeDefined();
      expect(screen.getByText('ORD-3DS-PASS')).toBeDefined();
    });
  });

  it('allows user to cancel 3D Secure modal and enter retry state', async () => {
    vi.mocked(checkoutApi.submitPaymentAttempt).mockResolvedValueOnce({
      id: 'att-act-cancel',
      paymentIntentId: 'pi-123',
      provider: 'stripe',
      providerTransactionId: 'txn_act_cancel',
      amount: 99.99,
      currency: 'USD',
      status: 'REQUIRES_ACTION',
      failureCode: 'requires_action',
      failureMessage: 'Cardholder action required (3DS / SCA)',
    });

    render(
      <BrowserRouter>
        <CheckoutPage />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Premium Headphones')).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText(/Full name/i), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText(/Street address/i), { target: { value: '123 Market St' } });
    fireEvent.change(screen.getByLabelText(/City/i), { target: { value: 'San Francisco' } });
    fireEvent.change(screen.getByLabelText(/PIN code/i), { target: { value: '94105' } });

    fireEvent.submit(screen.getByRole('button', { name: /Pay/i }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByText(/3D Secure Authentication/i)).toBeDefined();
    });

    // Click Cancel in modal
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));

    await waitFor(() => {
      expect(screen.getByText(/3D Secure verification was cancelled/i)).toBeDefined();
      expect(screen.getByRole('button', { name: /Retry Payment/i })).toBeDefined();
    });
  });
});
