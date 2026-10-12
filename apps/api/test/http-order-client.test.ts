import { describe, it, expect, vi } from 'vitest';
import {
  HttpOrderClient,
  InMemoryOrderStore,
  type CustomerOrderDto,
  type SellerOrderDto,
} from '../src/modules/orders/index.js';
import type { AuthorizedActor } from '../src/modules/identity/rbac/policy.js';
import {
  ValidationError,
  NotFoundError,
  InvalidStateTransitionError,
} from '../src/errors/app-error.js';

const mockCustomerActor: AuthorizedActor = {
  userId: 'usr-customer-1',
  tenantId: 'tenant-customer-1',
  role: 'CUSTOMER',
};

const mockSellerActor: AuthorizedActor = {
  userId: 'usr-seller-1',
  tenantId: 'tenant-seller-1',
  role: 'MERCHANT',
};

const mockSellerOrder: SellerOrderDto = {
  id: 'seller-ord-1',
  customerOrderId: 'order-123',
  sellerTenantId: 'tenant-seller-1',
  status: 'PAID',
  currency: 'INR',
  subtotalAmount: 1000,
  totalAmount: 1000,
  shippingAmount: 0,
  taxAmount: 0,
  discountAmount: 0,
  items: [
    {
      id: 'item-1',
      sellerOrderId: 'seller-ord-1',
      customerOrderId: 'order-123',
      listingId: 'list-1',
      skuId: 'sku-1',
      productId: 'prod-1',
      merchantTenantId: 'tenant-seller-1',
      productName: 'Product 1',
      skuCode: 'SKU-001',
      variantInfo: {},
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

const mockCustomerOrder: CustomerOrderDto = {
  id: 'order-123',
  customerTenantId: 'tenant-customer-1',
  checkoutSessionId: 'chk-session-1',
  paymentIntentId: 'pi-123',
  currency: 'INR',
  subtotalAmount: 1000,
  discountAmount: 0,
  shippingAmount: 0,
  taxAmount: 0,
  totalAmount: 1000,
  status: 'PAID',
  idempotencyKey: 'idem-1',
  sellerOrders: [mockSellerOrder],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('HttpOrderClient', () => {
  it('delegates createOrderFromCheckout over HTTP with actor headers', async () => {
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockCustomerOrder), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new HttpOrderClient('http://order-service:4120', { fetchFn });
    const result = await client.createOrderFromCheckout(mockCustomerActor, {
      checkoutSessionId: 'chk-session-1',
      paymentIntentId: 'pi-123',
      idempotencyKey: 'idem-1',
    });

    expect(result).toEqual(mockCustomerOrder);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://order-service:4120/orders');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual(
      expect.objectContaining({
        'content-type': 'application/json',
        'x-user-id': 'usr-customer-1',
        'x-tenant-id': 'tenant-customer-1',
        'x-user-role': 'CUSTOMER',
      }),
    );
  });

  it('delegates getCustomerOrder over HTTP', async () => {
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockCustomerOrder), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new HttpOrderClient('http://order-service:4120', { fetchFn });
    const result = await client.getCustomerOrder(mockCustomerActor, 'order-123');

    expect(result.id).toBe('order-123');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://order-service:4120/orders/order-123');
    expect(init.method).toBe('GET');
  });

  it('delegates listCustomerOrders with pagination query params', async () => {
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify([mockCustomerOrder]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new HttpOrderClient('http://order-service:4120', { fetchFn });
    const result = await client.listCustomerOrders(mockCustomerActor, { limit: 10, offset: 5 });

    expect(result).toHaveLength(1);
    const [url] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://order-service:4120/orders?limit=10&offset=5');
  });

  it('delegates getSellerOrder over HTTP', async () => {
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockSellerOrder), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new HttpOrderClient('http://order-service:4120', { fetchFn });
    const result = await client.getSellerOrder(mockSellerActor, 'seller-ord-1');

    expect(result.id).toBe('seller-ord-1');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://order-service:4120/seller/orders/seller-ord-1');
    expect(init.method).toBe('GET');
  });

  it('delegates listSellerOrders with query parameters', async () => {
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify([mockSellerOrder]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new HttpOrderClient('http://order-service:4120', { fetchFn });
    const result = await client.listSellerOrders(mockSellerActor, {
      limit: 20,
      offset: 0,
    });

    expect(result).toHaveLength(1);
    const [url] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://order-service:4120/seller/orders?limit=20&offset=0');
  });

  it('delegates updateCustomerOrderStatus via PATCH', async () => {
    const updatedOrder = { ...mockCustomerOrder, status: 'PAID' as const };
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(updatedOrder), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new HttpOrderClient('http://order-service:4120', { fetchFn });
    const result = await client.updateCustomerOrderStatus(mockCustomerActor, 'order-123', 'PAID');

    expect(result.status).toBe('PAID');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://order-service:4120/orders/order-123/status');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ status: 'PAID' });
  });

  it('delegates updateSellerOrderStatus via PATCH', async () => {
    const updatedSellerOrder = { ...mockSellerOrder, status: 'PROCESSING' as const };
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(updatedSellerOrder), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new HttpOrderClient('http://order-service:4120', { fetchFn });
    const result = await client.updateSellerOrderStatus(
      mockSellerActor,
      'seller-ord-1',
      'PROCESSING',
    );

    expect(result.status).toBe('PROCESSING');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://order-service:4120/seller/orders/seller-ord-1/status');
    expect(init.method).toBe('PATCH');
  });

  it('maps error codes correctly from HTTP response', async () => {
    const validationFetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Missing fields' } }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
        ),
      );
    const client = new HttpOrderClient('http://order-service:4120', { fetchFn: validationFetch });
    await expect(
      client.createOrderFromCheckout(mockCustomerActor, {
        checkoutSessionId: '',
        paymentIntentId: '',
      }),
    ).rejects.toThrowError(ValidationError);

    const notFoundFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Order missing' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const notFoundClient = new HttpOrderClient('http://order-service:4120', {
      fetchFn: notFoundFetch,
    });
    await expect(
      notFoundClient.getCustomerOrder(mockCustomerActor, 'order-missing'),
    ).rejects.toThrowError(NotFoundError);

    const transitionFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: 'INVALID_STATE_TRANSITION', message: 'Cannot transition' },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const transitionClient = new HttpOrderClient('http://order-service:4120', {
      fetchFn: transitionFetch,
    });
    await expect(
      transitionClient.updateCustomerOrderStatus(mockCustomerActor, 'order-123', 'CANCELLED'),
    ).rejects.toThrowError(InvalidStateTransitionError);
  });

  it('resiliently falls back to local/in-memory store on connection failure', async () => {
    const memoryStore = new InMemoryOrderStore();
    memoryStore.seedCustomerOrder(mockCustomerOrder);

    const failingFetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.reject(new Error('ECONNREFUSED connect to order-service:4120')),
      );

    const client = new HttpOrderClient('http://order-service:4120', {
      fetchFn: failingFetch,
      fallbackService: memoryStore,
    });

    const order = await client.getCustomerOrder(mockCustomerActor, 'order-123');
    expect(order.id).toBe('order-123');

    const sellerOrders = await client.listSellerOrders(mockSellerActor);
    expect(sellerOrders).toHaveLength(1);
  });
});
