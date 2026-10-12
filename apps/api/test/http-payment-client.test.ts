import { describe, it, expect, vi } from 'vitest';
import {
  HttpPaymentClient,
  InMemoryPaymentStore,
  type PaymentIntentDto,
  type PaymentAttemptDto,
  type PaymentRefundDto,
} from '../src/modules/payment/index.js';
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

const mockAdminActor: AuthorizedActor = {
  userId: 'usr-admin-1',
  tenantId: 'tenant-admin-1',
  role: 'ADMINISTRATOR',
};

const mockPaymentIntent: PaymentIntentDto = {
  id: 'pi-123',
  customerTenantId: 'tenant-customer-1',
  checkoutSessionId: 'chk-session-1',
  orderId: null,
  amount: 1000,
  currency: 'INR',
  status: 'CREATED',
  provider: 'mock',
  clientSecret: 'sec_pi_123',
  idempotencyKey: 'idem-pi-1',
  metadata: { customField: 'test' },
  paymentMethod: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  attempts: [],
};

const mockPaymentAttempt: PaymentAttemptDto = {
  id: 'att-123',
  paymentIntentId: 'pi-123',
  provider: 'mock',
  providerTransactionId: 'txn-12345',
  amount: 1000,
  currency: 'INR',
  status: 'SUCCEEDED',
  failureCode: null,
  failureMessage: null,
  providerResponse: { status: 'SUCCEEDED' },
  idempotencyKey: 'idem-att-1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockRefund: PaymentRefundDto = {
  id: 'ref-123',
  paymentIntentId: 'pi-123',
  paymentAttemptId: null,
  amount: 500,
  currency: 'INR',
  status: 'SUCCEEDED',
  providerRefundId: 're-12345',
  reason: 'Customer requested cancellation',
  idempotencyKey: 'idem-ref-1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('HttpPaymentClient', () => {
  it('delegates createPaymentIntent over HTTP with actor headers', async () => {
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockPaymentIntent), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new HttpPaymentClient('http://payment-service:4130', { fetchFn });
    const result = await client.createPaymentIntent(mockCustomerActor, {
      checkoutSessionId: 'chk-session-1',
      idempotencyKey: 'idem-pi-1',
      metadata: { customField: 'test' },
    });

    expect(result).toEqual(mockPaymentIntent);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://payment-service:4130/payments/intents');
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

  it('delegates getPaymentIntent over HTTP', async () => {
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockPaymentIntent), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new HttpPaymentClient('http://payment-service:4130', { fetchFn });
    const result = await client.getPaymentIntent(mockCustomerActor, 'pi-123');

    expect(result.id).toBe('pi-123');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://payment-service:4130/payments/intents/pi-123');
    expect(init.method).toBe('GET');
  });

  it('delegates createPaymentAttempt over HTTP', async () => {
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockPaymentAttempt), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new HttpPaymentClient('http://payment-service:4130', { fetchFn });
    const result = await client.createPaymentAttempt(mockCustomerActor, 'pi-123', {
      paymentMethod: 'pm_card_visa',
      idempotencyKey: 'idem-att-1',
    });

    expect(result.id).toBe('att-123');
    expect(result.status).toBe('SUCCEEDED');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://payment-service:4130/payments/intents/pi-123/attempts');
    expect(init.method).toBe('POST');
  });

  it('delegates createRefund over HTTP', async () => {
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockRefund), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new HttpPaymentClient('http://payment-service:4130', { fetchFn });
    const result = await client.createRefund(mockAdminActor, 'pi-123', {
      amount: 500,
      reason: 'Customer requested cancellation',
      idempotencyKey: 'idem-ref-1',
    });

    expect(result.id).toBe('ref-123');
    expect(result.amount).toBe(500);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://payment-service:4130/payments/intents/pi-123/refund');
    expect(init.method).toBe('POST');
  });

  it('delegates processWebhook over HTTP with signature headers', async () => {
    const webhookResult = {
      processed: true,
      duplicate: false,
      providerEventId: 'evt_stripe_1',
      eventType: 'payment_intent.succeeded',
    };

    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(webhookResult), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const client = new HttpPaymentClient('http://payment-service:4130', { fetchFn });
    const result = await client.processWebhook(
      'stripe',
      JSON.stringify({ id: 'evt_stripe_1', type: 'payment_intent.succeeded' }),
      't=123,v1=abcdef',
    );

    expect(result.processed).toBe(true);
    expect(result.providerEventId).toBe('evt_stripe_1');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://payment-service:4130/payments/webhooks/stripe');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual(
      expect.objectContaining({
        'content-type': 'application/json',
        'x-webhook-signature': 't=123,v1=abcdef',
        'stripe-signature': 't=123,v1=abcdef',
      }),
    );
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
    const client = new HttpPaymentClient('http://payment-service:4130', {
      fetchFn: validationFetch,
    });
    await expect(
      client.createPaymentIntent(mockCustomerActor, { checkoutSessionId: '' }),
    ).rejects.toThrowError(ValidationError);

    const notFoundFetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Payment intent not found' } }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          ),
        ),
      );
    const notFoundClient = new HttpPaymentClient('http://payment-service:4130', {
      fetchFn: notFoundFetch,
    });
    await expect(
      notFoundClient.getPaymentIntent(mockCustomerActor, 'pi-missing'),
    ).rejects.toThrowError(NotFoundError);

    const transitionFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: 'INVALID_STATE_TRANSITION',
              message: 'Intent already succeeded',
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const transitionClient = new HttpPaymentClient('http://payment-service:4130', {
      fetchFn: transitionFetch,
    });
    await expect(
      transitionClient.createPaymentAttempt(mockCustomerActor, 'pi-123', {}),
    ).rejects.toThrowError(InvalidStateTransitionError);
  });

  it('resiliently falls back to local/in-memory store on connection failure', async () => {
    const memoryStore = new InMemoryPaymentStore();
    memoryStore.seedPaymentIntent(mockPaymentIntent);

    const failingFetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.reject(new Error('ECONNREFUSED connect to payment-service:4130')),
      );

    const client = new HttpPaymentClient('http://payment-service:4130', {
      fetchFn: failingFetch,
      fallbackService: memoryStore,
    });

    const intent = await client.getPaymentIntent(mockCustomerActor, 'pi-123');
    expect(intent.id).toBe('pi-123');

    const attempt = await client.createPaymentAttempt(mockCustomerActor, 'pi-123', {
      paymentMethod: 'card',
    });
    expect(attempt.status).toBe('SUCCEEDED');
  });
});
