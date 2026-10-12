import { describe, it, expect, vi } from 'vitest';
import {
  HttpCartClient,
  HttpCheckoutClient,
  InMemoryCartStore,
  InMemoryCheckoutStore,
  type CartDto,
  type CheckoutSessionDto,
} from '../src/modules/cart-checkout/index.js';
import type { AuthorizedActor } from '../src/modules/identity/rbac/policy.js';
import {
  ValidationError,
  NotFoundError,
  EmptyCartError,
  CheckoutExpiredError,
  CheckoutValidationError,
  InvalidStateTransitionError,
} from '../src/errors/app-error.js';

const mockActor: AuthorizedActor = {
  userId: 'usr-customer-1',
  tenantId: 'tenant-customer-1',
  role: 'CUSTOMER',
};

const mockCart: CartDto = {
  id: 'cart-123',
  tenantId: 'tenant-customer-1',
  status: 'ACTIVE',
  items: [
    {
      id: 'item-1',
      listingId: 'list-1',
      skuId: 'sku-1',
      merchantTenantId: 'merchant-alpha',
      quantity: 2,
      unitPriceAmount: 500,
      lineTotalAmount: 1000,
      currency: 'INR',
      listingStatus: 'ACTIVE',
      isAvailable: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  itemCount: 2,
  subtotalAmount: 1000,
  currency: 'INR',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockCheckoutSession: CheckoutSessionDto = {
  id: 'chk-session-1',
  cartId: 'cart-123',
  customerTenantId: 'tenant-customer-1',
  status: 'OPEN',
  currency: 'INR',
  subtotalAmount: 1000,
  discountAmount: 0,
  shippingAmount: 0,
  taxAmount: 0,
  totalAmount: 1000,
  idempotencyKey: 'idem-key-1',
  expiresAt: new Date(Date.now() + 900000).toISOString(),
  reservedAt: null,
  cancelledAt: null,
  failedAt: null,
  failureReason: null,
  couponCode: null,
  appliedPromotions: [],
  shippingAddress: null,
  items: [
    {
      id: 'ci-1',
      checkoutSessionId: 'chk-session-1',
      listingId: 'list-1',
      skuId: 'sku-1',
      merchantTenantId: 'merchant-alpha',
      quantity: 2,
      unitPriceAmount: 500,
      lineTotalAmount: 1000,
      currency: 'INR',
      inventoryReservationId: null,
      createdAt: new Date().toISOString(),
    },
  ],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('HttpCartClient', () => {
  it('delegates getOrCreateCart over HTTP with actor headers', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockCart), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const client = new HttpCartClient('http://cart-service.internal:4100', { fetchFn });
    const result = await client.getOrCreateCart(mockActor);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://cart-service.internal:4100/cart');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['x-user-id']).toBe(mockActor.userId);
    expect((init.headers as Record<string, string>)['x-tenant-id']).toBe(mockActor.tenantId);
    expect(result.id).toBe(mockCart.id);
  });

  it('delegates addItem, updateItemQuantity, removeItem, and clearCart', async () => {
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockCart), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new HttpCartClient('http://cart-service.internal:4100', { fetchFn });

    await client.addItem(mockActor, { listingId: 'list-1', quantity: 2 });
    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://cart-service.internal:4100/cart/items');
    expect(fetchFn.mock.calls[0]?.[1]?.method).toBe('POST');

    await client.updateItemQuantity(mockActor, 'item-1', { quantity: 5 });
    expect(fetchFn.mock.calls[1]?.[0]).toBe('http://cart-service.internal:4100/cart/items/item-1');
    expect(fetchFn.mock.calls[1]?.[1]?.method).toBe('PATCH');

    await client.removeItem(mockActor, 'item-1');
    expect(fetchFn.mock.calls[2]?.[0]).toBe('http://cart-service.internal:4100/cart/items/item-1');
    expect(fetchFn.mock.calls[2]?.[1]?.method).toBe('DELETE');

    await client.clearCart(mockActor);
    expect(fetchFn.mock.calls[3]?.[0]).toBe('http://cart-service.internal:4100/cart');
    expect(fetchFn.mock.calls[3]?.[1]?.method).toBe('DELETE');
  });

  it('maps HTTP 400 and 404 to ValidationError and NotFoundError', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'quantity must be positive' }), { status: 400 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Cart item not found' }), { status: 404 }),
      );

    const client = new HttpCartClient('http://cart-service.internal:4100', { fetchFn });

    await expect(
      client.addItem(mockActor, { listingId: 'list-1', quantity: 0 }),
    ).rejects.toThrowError(ValidationError);

    await expect(client.removeItem(mockActor, 'nonexistent')).rejects.toThrowError(NotFoundError);
  });

  it('falls back to fallbackService when remote cart service fails', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const fallbackStore = new InMemoryCartStore();

    const client = new HttpCartClient('http://cart-service.internal:4100', {
      fetchFn,
      fallbackService: fallbackStore,
    });

    const cart = await client.getOrCreateCart(mockActor);
    expect(cart.tenantId).toBe(mockActor.tenantId);
    expect(cart.items).toHaveLength(0);

    const updated = await client.addItem(mockActor, { listingId: 'list-fall-1', quantity: 3 });
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0]?.listingId).toBe('list-fall-1');
    expect(updated.items[0]?.quantity).toBe(3);
  });
});

describe('HttpCheckoutClient', () => {
  it('delegates createCheckoutSession over HTTP with actor headers', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockCheckoutSession), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const client = new HttpCheckoutClient('http://checkout-service.internal:4110', { fetchFn });
    const result = await client.createCheckoutSession(mockActor, { idempotencyKey: 'idem-key-1' });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://checkout-service.internal:4110/checkout/sessions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-user-id']).toBe(mockActor.userId);
    expect(result.id).toBe(mockCheckoutSession.id);
  });

  it('delegates setShippingAddress, reserveCheckoutInventory, getCheckoutSession, expire, and cancel', async () => {
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockCheckoutSession), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new HttpCheckoutClient('http://checkout-service.internal:4110', { fetchFn });

    await client.getCheckoutSession(mockActor, 'chk-session-1');
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      'http://checkout-service.internal:4110/checkout/sessions/chk-session-1',
    );
    expect(fetchFn.mock.calls[0]?.[1]?.method).toBe('GET');

    await client.setShippingAddress(mockActor, 'chk-session-1', {
      shippingAddress: {
        sourceType: 'MANUAL_ENTRY',
        recipientName: 'Abhinav',
        phone: '1234567890',
        addressLine1: 'Main St',
        city: 'Metropolis',
        state: 'NY',
        postalCode: '10001',
        country: 'US',
      },
    });
    expect(fetchFn.mock.calls[1]?.[0]).toBe(
      'http://checkout-service.internal:4110/checkout/sessions/chk-session-1/address',
    );
    expect(fetchFn.mock.calls[1]?.[1]?.method).toBe('POST');

    await client.reserveCheckoutInventory(mockActor, 'chk-session-1');
    expect(fetchFn.mock.calls[2]?.[0]).toBe(
      'http://checkout-service.internal:4110/checkout/sessions/chk-session-1/reserve',
    );
    expect(fetchFn.mock.calls[2]?.[1]?.method).toBe('POST');

    await client.expireCheckoutSession(mockActor, 'chk-session-1');
    expect(fetchFn.mock.calls[3]?.[0]).toBe(
      'http://checkout-service.internal:4110/checkout/sessions/chk-session-1/expire',
    );
    expect(fetchFn.mock.calls[3]?.[1]?.method).toBe('POST');

    await client.cancelCheckoutSession(mockActor, 'chk-session-1');
    expect(fetchFn.mock.calls[4]?.[0]).toBe(
      'http://checkout-service.internal:4110/checkout/sessions/chk-session-1/cancel',
    );
    expect(fetchFn.mock.calls[4]?.[1]?.method).toBe('POST');
  });

  it('maps domain errors: EmptyCartError, CheckoutExpiredError, CheckoutValidationError, InvalidStateTransitionError', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ name: 'EmptyCartError', message: 'Cannot checkout an empty cart' }),
          {
            status: 400,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ name: 'CheckoutExpiredError', message: 'Checkout session has expired' }),
          {
            status: 400,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: 'CheckoutValidationError',
            message: 'Idempotency key reuse detected with different cart contents',
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: 'InvalidStateTransitionError',
            message: 'Cannot reserve inventory for checkout session in status CANCELLED',
          }),
          { status: 400 },
        ),
      );

    const client = new HttpCheckoutClient('http://checkout-service.internal:4110', { fetchFn });

    await expect(client.createCheckoutSession(mockActor)).rejects.toThrowError(EmptyCartError);
    await expect(client.reserveCheckoutInventory(mockActor, 'chk-1')).rejects.toThrowError(
      CheckoutExpiredError,
    );
    await expect(
      client.createCheckoutSession(mockActor, { idempotencyKey: 'k1' }),
    ).rejects.toThrowError(CheckoutValidationError);
    await expect(client.reserveCheckoutInventory(mockActor, 'chk-1')).rejects.toThrowError(
      InvalidStateTransitionError,
    );
  });

  it('falls back to fallbackService when remote checkout service fails', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const cartStore = new InMemoryCartStore();
    await cartStore.addItem(mockActor, { listingId: 'list-item-1', quantity: 2 });
    const fallbackCheckoutStore = new InMemoryCheckoutStore(cartStore);

    const client = new HttpCheckoutClient('http://checkout-service.internal:4110', {
      fetchFn,
      fallbackService: fallbackCheckoutStore,
    });

    const session = await client.createCheckoutSession(mockActor);
    expect(session.customerTenantId).toBe(mockActor.tenantId);
    expect(session.items).toHaveLength(1);
    expect(session.status).toBe('OPEN');

    const reserved = await client.reserveCheckoutInventory(mockActor, session.id);
    expect(reserved.status).toBe('READY');
    expect(reserved.items[0]?.inventoryReservationId).toBeTruthy();
  });
});
