import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { Logger } from '../../../observability/logger.js';
import type {
  PaymentProvider,
  ProviderCreateIntentInput,
  ProviderIntentResult,
  ProviderCreateAttemptInput,
  ProviderAttemptResult,
  ProviderWebhookEvent,
  ProviderRefundInput,
  ProviderRefundResult,
} from './payment-provider.js';

export interface RazorpayPaymentConfig {
  keyId: string;
  keySecret: string;
  webhookSecret?: string | undefined;
  baseUrl?: string | undefined;
  fetchFn?: typeof fetch | undefined;
}

/**
 * Converts decimal amount (e.g. 299.50) to smallest currency unit (paise / cents: 29950).
 * If the amount is already an integer minor unit (e.g. 9997 cents from checkout_sessions),
 * it preserves the authoritative integer minor unit.
 */
export function toRazorpayAmount(amount: number): number {
  if (!Number.isInteger(amount)) {
    return Math.round(amount * 100);
  }
  return Math.round(amount);
}

/**
 * Converts Razorpay integer amount (paise / cents) back to decimal currency units.
 */
export function fromRazorpayAmount(paise: number): number {
  return Number((paise / 100).toFixed(2));
}

/**
 * Production Razorpay Payment Provider.
 * Integrates with Razorpay Orders API for UPI (GPay, PhonePe, Paytm),
 * Credit/Debit Cards, Netbanking, and verifies HMAC-SHA256 signatures.
 */
export class RazorpayPaymentProvider implements PaymentProvider {
  readonly name = 'razorpay';

  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: RazorpayPaymentConfig,
    private readonly logger: Logger,
  ) {
    this.keyId = config.keyId;
    this.keySecret = config.keySecret;
    this.webhookSecret = config.webhookSecret ?? '';
    this.baseUrl = config.baseUrl ?? 'https://api.razorpay.com/v1';
    this.fetchImpl = config.fetchFn ?? fetch;
  }

  getPublicKey(): string {
    return this.keyId;
  }

  /**
   * Creates a Razorpay Order.
   */
  async createIntent(input: ProviderCreateIntentInput): Promise<ProviderIntentResult> {
    const amountInPaise = toRazorpayAmount(input.amount);
    const currency = (input.currency || 'INR').toUpperCase();
    const receipt = `rcpt_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    // In sandbox/test mode without live keys, generate deterministic order
    const isMock = !this.keyId || this.keyId.startsWith('rzp_mock') || this.keyId === 'placeholder';

    if (isMock) {
      const orderId = `order_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
      return {
        providerTransactionId: orderId,
        clientSecret: orderId,
        status: 'CREATED',
        rawResponse: {
          id: orderId,
          entity: 'order',
          amount: amountInPaise,
          currency,
          receipt,
          status: 'created',
          provider: 'razorpay_mock',
        },
      };
    }

    try {
      const authHeader = 'Basic ' + Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');
      const res = await this.fetchImpl(`${this.baseUrl}/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify({
          amount: amountInPaise,
          currency,
          receipt,
          notes: {
            idempotencyKey: input.idempotencyKey ?? null,
            ...(input.metadata ?? {}),
          },
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        this.logger.error('Razorpay order creation failed', {
          status: res.status,
          error: errorText,
        });
        throw new Error(`Razorpay order creation failed (${res.status}): ${errorText}`);
      }

      const orderData = (await res.json()) as { id: string; status: string; [key: string]: unknown };

      return {
        providerTransactionId: orderData.id,
        clientSecret: orderData.id,
        status: 'CREATED',
        rawResponse: orderData,
      };
    } catch (err: unknown) {
      this.logger.error('Razorpay createIntent exception', { error: err });
      throw err;
    }
  }

  /**
   * Verifies Razorpay Payment Signature for an order.
   * Input paymentMethod carries JSON or formatted string:
   * { razorpay_order_id, razorpay_payment_id, razorpay_signature }
   */
  async createAttempt(input: ProviderCreateAttemptInput): Promise<ProviderAttemptResult> {
    const paymentMethodRaw = input.paymentMethod ?? '';

    let paymentId = '';
    let orderId = input.providerTransactionId;
    let signature = '';

    try {
      if (paymentMethodRaw.startsWith('{')) {
        const parsed = JSON.parse(paymentMethodRaw);
        paymentId = parsed.razorpay_payment_id || parsed.paymentId || '';
        orderId = parsed.razorpay_order_id || parsed.orderId || orderId;
        signature = parsed.razorpay_signature || parsed.signature || '';
      } else if (paymentMethodRaw.includes('|')) {
        const parts = paymentMethodRaw.split('|');
        paymentId = parts[0] || '';
        signature = parts[1] || '';
      } else {
        paymentId = paymentMethodRaw;
      }
    } catch {
      paymentId = paymentMethodRaw;
    }

    // Deterministic simulation handling:
    if (paymentMethodRaw.includes('fail') || paymentMethodRaw.includes('decline')) {
      return {
        providerTransactionId: input.providerTransactionId,
        status: 'FAILED',
        failureCode: 'payment_declined',
        failureMessage: 'Payment was declined by customer bank or UPI app',
        rawResponse: { status: 'failed', method: paymentMethodRaw },
      };
    }

    const isMock = !this.keyId || this.keyId.startsWith('rzp_mock') || this.keyId === 'placeholder';

    if (isMock) {
      // Mock validation succeeds unless explicitly failed
      const mockPayId = paymentId || `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
      return {
        providerTransactionId: mockPayId,
        status: 'SUCCEEDED',
        rawResponse: {
          id: mockPayId,
          order_id: orderId,
          status: 'captured',
          method: 'upi',
        },
      };
    }

    // Live verification: verify HMAC signature: sha256(order_id + "|" + payment_id, secret)
    if (!signature || !paymentId) {
      return {
        providerTransactionId: input.providerTransactionId,
        status: 'FAILED',
        failureCode: 'missing_signature',
        failureMessage: 'Razorpay payment ID or signature missing from checkout response',
      };
    }

    const expectedSignature = createHmac('sha256', this.keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    const sigBuf = Buffer.from(signature, 'utf-8');
    const expBuf = Buffer.from(expectedSignature, 'utf-8');
    const isValid = sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);

    if (!isValid) {
      this.logger.warn('Razorpay signature mismatch', { orderId, paymentId });
      return {
        providerTransactionId: paymentId,
        status: 'FAILED',
        failureCode: 'signature_verification_failed',
        failureMessage: 'Razorpay payment signature could not be verified',
      };
    }

    return {
      providerTransactionId: paymentId,
      status: 'SUCCEEDED',
      rawResponse: {
        id: paymentId,
        order_id: orderId,
        status: 'captured',
      },
    };
  }

  /**
   * Verifies Razorpay Webhook signature (X-Razorpay-Signature header).
   */
  verifyWebhookSignature(rawBody: string, signature: string, secret?: string): boolean {
    const webhookSecret = secret || this.webhookSecret;
    if (!webhookSecret || !signature) {
      return false;
    }

    try {
      const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
      const sigBuf = Buffer.from(signature, 'utf-8');
      const expBuf = Buffer.from(expected, 'utf-8');
      return sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
    } catch {
      return false;
    }
  }

  /**
   * Parses Razorpay webhook payload.
   */
  parseWebhookEvent(rawBody: string): ProviderWebhookEvent {
    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    const event = (payload.event as string) || 'unknown';
    const eventEntity = ((payload.payload as Record<string, unknown>)?.payment as Record<string, unknown>)?.entity as
      | Record<string, unknown>
      | undefined;

    const paymentId = (eventEntity?.id as string | undefined) || (payload.id as string);
    const orderId = (eventEntity?.order_id as string | undefined);
    const amountInPaise = (eventEntity?.amount as number | undefined) || 0;
    const currency = (eventEntity?.currency as string | undefined) || 'INR';

    let status: 'SUCCEEDED' | 'FAILED' | undefined;
    if (event === 'payment.captured' || event === 'order.paid') {
      status = 'SUCCEEDED';
    } else if (event === 'payment.failed') {
      status = 'FAILED';
    }

    return {
      providerEventId: (payload.account_id as string | undefined) ? `${payload.account_id}_${paymentId}` : paymentId,
      eventType: event,
      providerTransactionId: paymentId,
      paymentIntentId: orderId,
      amount: fromRazorpayAmount(amountInPaise),
      currency,
      status,
      rawPayload: payload,
    };
  }

  /**
   * Creates a refund for a captured Razorpay payment.
   */
  async createRefund(input: ProviderRefundInput): Promise<ProviderRefundResult> {
    const isMock = !this.keyId || this.keyId.startsWith('rzp_mock') || this.keyId === 'placeholder';

    if (isMock) {
      const refundId = `rfnd_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
      return {
        providerRefundId: refundId,
        status: 'SUCCEEDED',
        rawResponse: { id: refundId, payment_id: input.providerTransactionId, amount: input.amount },
      };
    }

    const amountInPaise = toRazorpayAmount(input.amount);
    const authHeader = 'Basic ' + Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');

    const res = await this.fetchImpl(`${this.baseUrl}/payments/${input.providerTransactionId}/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify({
        amount: amountInPaise,
        notes: { reason: input.reason ?? 'Customer refund' },
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Razorpay refund failed: ${errorText}`);
    }

    const data = (await res.json()) as { id: string; status: string; [key: string]: unknown };
    return {
      providerRefundId: data.id,
      status: data.status === 'processed' ? 'SUCCEEDED' : 'PENDING',
      rawResponse: data,
    };
  }
}
