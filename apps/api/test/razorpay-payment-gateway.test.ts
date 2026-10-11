import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { JsonLogger } from '../src/observability/logger.js';
import {
  RazorpayPaymentProvider,
  toRazorpayAmount,
  fromRazorpayAmount,
} from '../src/modules/payment/index.js';

describe('Razorpay Real Payment Gateway Provider', () => {
  const logger = new JsonLogger({ serviceName: 'test', level: 'fatal', sink: () => undefined });
  const keyId = 'rzp_test_sampleKey12345';
  const keySecret = 'sampleSecret67890';
  const webhookSecret = 'sampleWebhookSecret999';

  it('1. Currency value scaling: accurately converts INR to paise and vice versa', () => {
    expect(toRazorpayAmount(299.50)).toBe(29950);
    expect(toRazorpayAmount(10.50)).toBe(1050);
    expect(toRazorpayAmount(9997)).toBe(9997);
    expect(fromRazorpayAmount(29950)).toBe(299.50);
    expect(fromRazorpayAmount(1050)).toBe(10.50);
  });

  it('2. createIntent: creates a valid Razorpay order with amount in paise', async () => {
    const mockOrders: Record<string, unknown>[] = [];
    const mockFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      mockOrders.push(body);
      return new Response(
        JSON.stringify({
          id: 'order_test_987654321',
          entity: 'order',
          amount: body.amount,
          currency: body.currency,
          receipt: body.receipt,
          status: 'created',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const provider = new RazorpayPaymentProvider(
      { keyId, keySecret, webhookSecret, fetchFn: mockFetch },
      logger,
    );

    const intent = await provider.createIntent({
      amount: 49950,
      currency: 'INR',
    });

    expect(intent.providerTransactionId).toBe('order_test_987654321');
    expect(intent.clientSecret).toBe('order_test_987654321');
    expect(intent.status).toBe('CREATED');
    expect(mockOrders[0]?.amount).toBe(49950);
    expect(mockOrders[0]?.currency).toBe('INR');
  });

  it('3. createAttempt: validates genuine HMAC-SHA256 signature', async () => {
    const provider = new RazorpayPaymentProvider(
      { keyId, keySecret, webhookSecret },
      logger,
    );

    const orderId = 'order_test_123456';
    const paymentId = 'pay_test_789012';
    const validSignature = createHmac('sha256', keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    const result = await provider.createAttempt({
      providerTransactionId: orderId,
      amount: 499.00,
      currency: 'INR',
      paymentMethod: JSON.stringify({
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: validSignature,
      }),
    });

    expect(result.status).toBe('SUCCEEDED');
    expect(result.providerTransactionId).toBe(paymentId);
  });

  it('4. createAttempt: rejects forged signature with failure status', async () => {
    const provider = new RazorpayPaymentProvider(
      { keyId, keySecret, webhookSecret },
      logger,
    );

    const orderId = 'order_test_123456';
    const paymentId = 'pay_test_789012';
    const forgedSignature = 'forged_invalid_signature_hex';

    const result = await provider.createAttempt({
      providerTransactionId: orderId,
      amount: 499.00,
      currency: 'INR',
      paymentMethod: JSON.stringify({
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: forgedSignature,
      }),
    });

    expect(result.status).toBe('FAILED');
    expect(result.failureCode).toBe('signature_verification_failed');
  });

  it('5. verifyWebhookSignature: validates official X-Razorpay-Signature', () => {
    const provider = new RazorpayPaymentProvider(
      { keyId, keySecret, webhookSecret },
      logger,
    );

    const payload = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_999', amount: 49900, currency: 'INR' } } },
    });

    const validSig = createHmac('sha256', webhookSecret).update(payload).digest('hex');
    expect(provider.verifyWebhookSignature(payload, validSig)).toBe(true);
    expect(provider.verifyWebhookSignature(payload, 'wrong_sig')).toBe(false);
  });

  it('6. parseWebhookEvent: extracts payment.captured details', () => {
    const provider = new RazorpayPaymentProvider(
      { keyId, keySecret, webhookSecret },
      logger,
    );

    const payload = JSON.stringify({
      event: 'payment.captured',
      account_id: 'acc_test_1',
      payload: {
        payment: {
          entity: {
            id: 'pay_12345',
            order_id: 'order_54321',
            amount: 79900,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });

    const parsed = provider.parseWebhookEvent(payload);
    expect(parsed.eventType).toBe('payment.captured');
    expect(parsed.providerTransactionId).toBe('pay_12345');
    expect(parsed.paymentIntentId).toBe('order_54321');
    expect(parsed.amount).toBe(799.00);
    expect(parsed.currency).toBe('INR');
    expect(parsed.status).toBe('SUCCEEDED');
  });
});
