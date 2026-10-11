import { describe, it, expect, vi } from 'vitest';
import {
  HttpFulfillmentClient,
  InMemoryFulfillmentStore,
  type ShipmentDto,
  type ReturnDto,
} from '../src/modules/fulfillment/index.js';
import type { AuthorizedActor } from '../src/modules/identity/rbac/policy.js';
import {
  ValidationError,
  NotFoundError,
  InvalidStateTransitionError,
} from '../src/errors/app-error.js';

const mockSellerActor: AuthorizedActor = {
  userId: 'usr-seller-1',
  tenantId: 'tenant-seller-1',
  role: 'MERCHANT',
};

const mockCustomerActor: AuthorizedActor = {
  userId: 'usr-customer-1',
  tenantId: 'tenant-customer-1',
  role: 'CUSTOMER',
};

const mockShipment: ShipmentDto = {
  id: 'ship-123',
  sellerOrderId: 'so-123',
  customerOrderId: 'co-123',
  sellerTenantId: 'tenant-seller-1',
  status: 'PENDING',
  carrier: 'MockCarrier',
  trackingNumber: 'TRK-12345678',
  trackingUrl: 'https://mockcarrier.test/track/TRK-12345678',
  carrierShipmentId: 'cs_123',
  labelUrl: 'https://carrier.mock/labels/sample.pdf',
  shippedAt: null,
  deliveredAt: null,
  estimatedDeliveryAt: null,
  idempotencyKey: 'idem-ship-1',
  metadata: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  items: [
    {
      id: 'item-1',
      shipmentId: 'ship-123',
      orderItemId: 'oi-1',
      quantity: 2,
      createdAt: new Date().toISOString(),
    },
  ],
};

const mockReturn: ReturnDto = {
  id: 'ret-123',
  customerOrderId: 'co-123',
  sellerOrderId: 'so-123',
  sellerTenantId: 'tenant-seller-1',
  customerTenantId: 'tenant-customer-1',
  status: 'REQUESTED',
  reason: 'Defective item',
  requestedAt: new Date().toISOString(),
  approvedAt: null,
  rejectedAt: null,
  receivedAt: null,
  completedAt: null,
  refundId: null,
  idempotencyKey: 'idem-ret-1',
  metadata: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  items: [
    {
      id: 'ritem-1',
      returnId: 'ret-123',
      orderItemId: 'oi-1',
      quantity: 1,
      reason: null,
      createdAt: new Date().toISOString(),
    },
  ],
};

describe('HttpFulfillmentClient', () => {
  it('delegates createShipment over HTTP with actor headers', async () => {
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockShipment), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new HttpFulfillmentClient('http://fulfillment-service:4140', { fetchFn });
    const result = await client.createShipment(mockSellerActor, {
      sellerOrderId: 'so-123',
      carrier: 'MockCarrier',
      items: [{ orderItemId: 'oi-1', quantity: 2 }],
      idempotencyKey: 'idem-ship-1',
    });

    expect(result).toEqual(mockShipment);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://fulfillment-service:4140/fulfillment/shipments');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual(
      expect.objectContaining({
        'content-type': 'application/json',
        'x-user-id': 'usr-seller-1',
        'x-tenant-id': 'tenant-seller-1',
        'x-user-role': 'MERCHANT',
      }),
    );
  });

  it('delegates getShipment and listShipments over HTTP', async () => {
    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/fulfillment/shipments/ship-123')) {
        return Promise.resolve(
          new Response(JSON.stringify(mockShipment), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify([mockShipment]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    const client = new HttpFulfillmentClient('http://fulfillment-service:4140', { fetchFn });

    const shipment = await client.getShipment(mockSellerActor, 'ship-123');
    expect(shipment.id).toBe('ship-123');

    const list = await client.listShipments(mockSellerActor, { sellerOrderId: 'so-123' });
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('ship-123');

    const [listUrl, listInit] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect(listUrl).toBe('http://fulfillment-service:4140/fulfillment/shipments?sellerOrderId=so-123');
    expect(listInit.method).toBe('GET');
  });

  it('delegates updateShipmentStatus, updateShipmentTracking, cancelShipment, and getShipmentTracking', async () => {
    const fetchFn = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/tracking') && init?.method === 'GET') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              eventId: 'evt-1',
              carrier: 'DHL',
              trackingNumber: 'DHL-999',
              status: 'IN_TRANSIT',
              timestamp: new Date().toISOString(),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(mockShipment), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    const client = new HttpFulfillmentClient('http://fulfillment-service:4140', { fetchFn });

    const statusResult = await client.updateShipmentStatus(mockSellerActor, 'ship-123', 'SHIPPED');
    expect(statusResult.id).toBe('ship-123');

    const trackingResult = await client.updateShipmentTracking(mockSellerActor, 'ship-123', {
      carrier: 'DHL',
      trackingNumber: 'DHL-999',
    });
    expect(trackingResult.id).toBe('ship-123');

    const cancelResult = await client.cancelShipment(mockSellerActor, 'ship-123');
    expect(cancelResult.id).toBe('ship-123');

    const tracking = await client.getShipmentTracking(mockSellerActor, 'ship-123');
    expect(tracking.status).toBe('IN_TRANSIT');
    expect(tracking.carrier).toBe('DHL');
  });

  it('delegates createReturnRequest, getReturn, listReturns, and updateReturnStatus', async () => {
    const fetchFn = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/fulfillment/returns?')) {
        return Promise.resolve(
          new Response(JSON.stringify([mockReturn]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(mockReturn), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    const client = new HttpFulfillmentClient('http://fulfillment-service:4140', { fetchFn });

    const ret = await client.createReturnRequest(mockCustomerActor, {
      customerOrderId: 'co-123',
      sellerOrderId: 'so-123',
      reason: 'Defective item',
      items: [{ orderItemId: 'oi-1', quantity: 1 }],
    });
    expect(ret.id).toBe('ret-123');

    const fetchedReturn = await client.getReturn(mockCustomerActor, 'ret-123');
    expect(fetchedReturn.id).toBe('ret-123');

    const returnsList = await client.listReturns(mockCustomerActor, { customerOrderId: 'co-123' });
    expect(returnsList).toHaveLength(1);

    const updatedReturn = await client.updateReturnStatus(mockSellerActor, 'ret-123', 'APPROVED');
    expect(updatedReturn.id).toBe('ret-123');
  });

  it('delegates handleCarrierCallback with signature headers', async () => {
    const callbackResponse = {
      processed: true,
      deduplicated: false,
      shipmentId: 'ship-123',
      status: 'IN_TRANSIT',
    };

    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(callbackResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new HttpFulfillmentClient('http://fulfillment-service:4140', { fetchFn });
    const result = await client.handleCarrierCallback(
      JSON.stringify({ shipmentId: 'ship-123', status: 'IN_TRANSIT' }),
      'carrier-sig-123',
    );

    expect(result.processed).toBe(true);
    expect(result.shipmentId).toBe('ship-123');

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://fulfillment-service:4140/fulfillment/carrier/callback');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual(
      expect.objectContaining({
        'content-type': 'application/json',
        'shippo-signature': 'carrier-sig-123',
        'x-carrier-signature': 'carrier-sig-123',
      }),
    );
  });

  it('maps error codes correctly from HTTP response', async () => {
    const validationFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Missing fields' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const client = new HttpFulfillmentClient('http://fulfillment-service:4140', {
      fetchFn: validationFetch,
    });
    await expect(
      client.createShipment(mockSellerActor, { sellerOrderId: '', items: [] }),
    ).rejects.toThrowError(ValidationError);

    const notFoundFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Shipment not found' } }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const notFoundClient = new HttpFulfillmentClient('http://fulfillment-service:4140', {
      fetchFn: notFoundFetch,
    });
    await expect(
      notFoundClient.getShipment(mockSellerActor, 'ship-missing'),
    ).rejects.toThrowError(NotFoundError);

    const transitionFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: 'INVALID_STATE_TRANSITION',
              message: 'Shipment already delivered',
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const transitionClient = new HttpFulfillmentClient('http://fulfillment-service:4140', {
      fetchFn: transitionFetch,
    });
    await expect(
      transitionClient.updateShipmentStatus(mockSellerActor, 'ship-123', 'SHIPPED'),
    ).rejects.toThrowError(InvalidStateTransitionError);
  });

  it('resiliently falls back to local/in-memory store on connection failure', async () => {
    const memoryStore = new InMemoryFulfillmentStore();
    memoryStore.seedShipment(mockShipment);
    memoryStore.seedReturn(mockReturn);

    const failingFetch = vi.fn().mockImplementation(() =>
      Promise.reject(new Error('ECONNREFUSED connect to fulfillment-service:4140')),
    );

    const client = new HttpFulfillmentClient('http://fulfillment-service:4140', {
      fetchFn: failingFetch,
      fallbackService: memoryStore,
    });

    const shipment = await client.getShipment(mockSellerActor, 'ship-123');
    expect(shipment.id).toBe('ship-123');

    const ret = await client.getReturn(mockCustomerActor, 'ret-123');
    expect(ret.id).toBe('ret-123');
  });
});
