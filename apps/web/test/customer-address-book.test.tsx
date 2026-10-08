import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { BrowserRouter } from 'react-router-dom';
import { AddressBook } from '../src/features/customer/AddressBook';
import { addressesApi, type CustomerAddressDto } from '../src/features/customer/api/addresses';
import { CheckoutPage } from '../src/features/checkout/CheckoutPage';
import { checkoutApi } from '../src/features/checkout/api/checkout';

vi.mock('../src/features/customer/api/addresses', () => ({
  addressesApi: {
    listAddresses: vi.fn(),
    getAddress: vi.fn(),
    createAddress: vi.fn(),
    updateAddress: vi.fn(),
    deleteAddress: vi.fn(),
    setDefaultAddress: vi.fn(),
  },
}));

vi.mock('../src/features/checkout/api/checkout', () => ({
  checkoutApi: {
    createSession: vi.fn(),
    setShippingAddress: vi.fn(),
    reserveInventory: vi.fn(),
    createPaymentIntent: vi.fn(),
    submitPaymentAttempt: vi.fn(),
    finalizeOrder: vi.fn(),
  },
}));

vi.mock('../src/features/cart/CartContext', () => ({
  useCart: () => ({
    refreshCart: vi.fn(),
  }),
  CartProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockAddresses: CustomerAddressDto[] = [
  {
    id: 'addr-1',
    tenantId: 'cust-tenant-1',
    customerId: 'cust-1',
    label: 'Home',
    recipientName: 'Alice Green',
    phone: '+1 555-0199',
    addressLine1: '123 Forest Hill',
    addressLine2: 'Apt 2',
    landmark: 'Behind Library',
    city: 'Seattle',
    state: 'WA',
    postalCode: '98101',
    country: 'US',
    latitude: 47.6062,
    longitude: -122.3321,
    googlePlaceId: 'place-sea-1',
    formattedAddress: '123 Forest Hill, Seattle, WA 98101, USA',
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'addr-2',
    tenantId: 'cust-tenant-1',
    customerId: 'cust-1',
    label: 'Work',
    recipientName: 'Bob Smith',
    phone: '+1 555-0199',
    addressLine1: '500 Tech Plaza',
    addressLine2: null,
    landmark: null,
    city: 'Bellevue',
    state: 'WA',
    postalCode: '98004',
    country: 'US',
    latitude: 47.6101,
    longitude: -122.2015,
    googlePlaceId: null,
    formattedAddress: null,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

describe('Customer Address Book & Checkout Frontend Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(addressesApi.listAddresses).mockResolvedValue(mockAddresses);
  });

  afterEach(() => {
    cleanup();
  });

  it('1. AddressBook renders saved address cards with badges, details, and coordinates', async () => {
    render(<AddressBook />);

    await waitFor(() => {
      expect(screen.getByText('Alice Green')).toBeDefined();
    });

    expect(screen.getByText(/Home/i)).toBeDefined();
    expect(screen.getByText(/Work/i)).toBeDefined();
    expect(screen.getByText('Default')).toBeDefined();
    expect(screen.getByText(/123 Forest Hill/i)).toBeDefined();
    expect(screen.getByText(/500 Tech Plaza/i)).toBeDefined();
    expect(screen.getByText(/47.6062, -122.3321/)).toBeDefined();
  });

  it('2. AddressBook handles set default address action', async () => {
    vi.mocked(addressesApi.setDefaultAddress).mockResolvedValue({
      ...mockAddresses[1]!,
      isDefault: true,
    });

    render(<AddressBook />);

    await waitFor(() => {
      expect(screen.getByText(/500 Tech Plaza/i)).toBeDefined();
    });

    const setDefaultBtn = screen.getByRole('button', { name: /Set Default/i });
    fireEvent.click(setDefaultBtn);

    await waitFor(() => {
      expect(addressesApi.setDefaultAddress).toHaveBeenCalledWith('addr-2');
    });
  });

  it('3. CheckoutPage loads saved addresses and pre-selects default address', async () => {
    const mockSession = {
      id: 'chk-sess-1',
      cartId: 'cart-1',
      customerTenantId: 'cust-1',
      status: 'READY' as const,
      currency: 'USD',
      subtotalAmount: 50,
      discountAmount: 0,
      shippingAmount: 0,
      taxAmount: 0,
      totalAmount: 50,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      items: [],
      createdAt: new Date().toISOString(),
    };

    vi.mocked(checkoutApi.createSession).mockResolvedValue(mockSession);
    vi.mocked(checkoutApi.reserveInventory).mockResolvedValue(mockSession);

    render(
      <BrowserRouter>
        <CheckoutPage />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(checkoutApi.createSession).toHaveBeenCalledWith({ addressId: 'addr-1' });
    });

    // Check that default address card shows as Selected
    await waitFor(() => {
      expect(screen.getByText('Selected')).toBeDefined();
      expect(screen.getByText(/123 Forest Hill/i)).toBeDefined();
    });
  });

  it('4. CheckoutPage allows switching to another saved address and updates session snapshot', async () => {
    const mockSession = {
      id: 'chk-sess-1',
      cartId: 'cart-1',
      customerTenantId: 'cust-1',
      status: 'READY' as const,
      currency: 'USD',
      subtotalAmount: 50,
      discountAmount: 0,
      shippingAmount: 0,
      taxAmount: 0,
      totalAmount: 50,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      items: [],
      createdAt: new Date().toISOString(),
    };

    vi.mocked(checkoutApi.createSession).mockResolvedValue(mockSession);
    vi.mocked(checkoutApi.reserveInventory).mockResolvedValue(mockSession);
    vi.mocked(checkoutApi.setShippingAddress).mockResolvedValue(mockSession);

    render(
      <BrowserRouter>
        <CheckoutPage />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/500 Tech Plaza/i)).toBeDefined();
    });

    // Click the second address card (Work)
    const workCard = screen.getByText(/500 Tech Plaza/i).closest('div')!;
    fireEvent.click(workCard);

    await waitFor(() => {
      expect(checkoutApi.setShippingAddress).toHaveBeenCalledWith('chk-sess-1', {
        addressId: 'addr-2',
      });
    });
  });
});
