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

export interface StripePaymentConfig {
  secretKey: string;
  webhookSecret?: string | undefined;
  publishableKey?: string | undefined;
  apiVersion?: string | undefined;
  baseUrl?: string | undefined;
  webhookToleranceSeconds?: number | undefined;
  fetchFn?: typeof fetch | undefined;
}

/**
 * Normalizes decimal currency amount into Stripe smallest unit (e.g. cents).
 * Currencies without decimal exponents (e.g. JPY, KRW) are unscaled.
 */
export function toStripeAmount(amount: number, currency = 'USD'): number {
  const zeroDecimalCurrencies = new Set([
    'JPY',
    'KRW',
    'UGX',
    'VND',
    'BIF',
    'CLP',
    'DJF',
    'GNF',
    'KMF',
    'MGA',
    'PYG',
    'RWF',
    'VUV',
  ]);
  const curr = currency.toUpperCase();
  if (zeroDecimalCurrencies.has(curr)) {
    return Math.round(amount);
  }
  return Math.round(amount * 100);
}

/**
 * Normalizes Stripe integer amount (cents) back into decimal currency amount.
 */
export function fromStripeAmount(cents: number, currency = 'USD'): number {
  const zeroDecimalCurrencies = new Set([
    'JPY',
    'KRW',
    'UGX',
    'VND',
    'BIF',
    'CLP',
    'DJF',
    'GNF',
    'KMF',
    'MGA',
    'PYG',
    'RWF',
    'VUV',
  ]);
  const curr = currency.toUpperCase();
  if (zeroDecimalCurrencies.has(curr)) {
    return cents;
  }
  return Number((cents / 100).toFixed(2));
}

/**
 * Production Stripe Payment Gateway Provider.
 * Communicates with Stripe v1 API using native fetch and verifies webhook
 * signatures according to Stripe's HMAC-SHA256 specification.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';

  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;
  private readonly webhookToleranceSeconds: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: StripePaymentConfig,
    private readonly logger: Logger,
  ) {
    if (!config.secretKey) {
      throw new Error('StripePaymentProvider requires secretKey');
    }

    this.secretKey = config.secretKey;
    this.webhookSecret = config.webhookSecret ?? '';
    this.baseUrl = config.baseUrl ?? 'https://api.stripe.com/v1';
    this.webhookToleranceSeconds = config.webhookToleranceSeconds ?? 300;
    this.fetchImpl = config.fetchFn ?? fetch;
  }

  /**
   * Helper to execute Stripe REST requests with url-encoded bodies,
   * authentication headers, idempotency keys, and 10s AbortController timeouts.
   */
  private async requestStripe<T = Record<string, unknown>>(
    endpoint: string,
    params: Record<string, string | number | undefined>,
    idempotencyKey?: string | null,
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        body.append(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: body.toString(),
        signal: controller.signal,
      });

      const responseBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (!response.ok) {
        const errorObj = (responseBody['error'] as Record<string, unknown> | undefined) ?? {};
        const errorMsg = String(errorObj['message'] ?? `Stripe error (HTTP ${response.status})`);
        const errorCode = String(errorObj['code'] ?? 'stripe_api_error');

        this.logger.warn('Stripe API request returned error', {
          endpoint,
          statusCode: response.status,
          errorCode,
        });

        const error = new Error(errorMsg);
        (error as { code?: string; stripeError?: Record<string, unknown> }).code = errorCode;
        (error as { code?: string; stripeError?: Record<string, unknown> }).stripeError = errorObj;
        throw error;
      }

      return responseBody as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async createIntent(input: ProviderCreateIntentInput): Promise<ProviderIntentResult> {
    const stripeAmount = toStripeAmount(input.amount, input.currency);
    const currency = input.currency.toLowerCase();

    const params: Record<string, string | number | undefined> = {
      amount: stripeAmount,
      currency,
      'automatic_payment_methods[enabled]': 'true',
    };

    if (input.metadata) {
      for (const [k, v] of Object.entries(input.metadata)) {
        if (typeof v === 'string' || typeof v === 'number') {
          params[`metadata[${k}]`] = v;
        }
      }
    }

    const data = await this.requestStripe<{
      id: string;
      client_secret: string;
      status: string;
    }>('/payment_intents', params, input.idempotencyKey);

    return {
      providerTransactionId: data.id,
      clientSecret: data.client_secret,
      status: 'CREATED',
      rawResponse: data as unknown as Record<string, unknown>,
    };
  }

  async createAttempt(input: ProviderCreateAttemptInput): Promise<ProviderAttemptResult> {
    const rawMethod = input.paymentMethod ?? 'pm_card_visa';

    // Map simulated failure triggers or standard card tokens
    let stripeMethod = rawMethod;
    if (
      rawMethod === 'pm_card_declined' ||
      rawMethod.toLowerCase().includes('fail') ||
      rawMethod.toLowerCase().includes('decline')
    ) {
      stripeMethod = 'pm_card_chargeCustomerFail';
    } else if (
      rawMethod === 'pm_card_threeDSecure2Required' ||
      rawMethod.toLowerCase().includes('3ds') ||
      rawMethod.toLowerCase().includes('action')
    ) {
      stripeMethod = 'pm_card_threeDSecure2Required';
    }

    try {
      const data = await this.requestStripe<{
        id: string;
        status: string;
        last_payment_error?: { code?: string; message?: string } | undefined;
      }>(
        `/payment_intents/${input.providerTransactionId}/confirm`,
        {
          payment_method: stripeMethod,
          return_url: 'https://example.com/checkout/complete',
        },
        input.idempotencyKey,
      );

      if (data.status === 'succeeded') {
        return {
          providerTransactionId: data.id,
          status: 'SUCCEEDED',
          rawResponse: data as unknown as Record<string, unknown>,
        };
      }

      if (
        data.status === 'requires_action' ||
        data.status === 'requires_confirmation' ||
        data.status === 'requires_source_action'
      ) {
        return {
          providerTransactionId: data.id,
          status: 'REQUIRES_ACTION',
          failureCode: 'requires_action',
          failureMessage: 'Cardholder action required (3DS / SCA)',
          rawResponse: data as unknown as Record<string, unknown>,
        };
      }

      return {
        providerTransactionId: data.id,
        status: 'FAILED',
        failureCode: data.last_payment_error?.code ?? 'payment_unconfirmed',
        failureMessage: data.last_payment_error?.message ?? `Status is ${data.status}`,
        rawResponse: data as unknown as Record<string, unknown>,
      };
    } catch (err: unknown) {
      const stripeErr = (err as { stripeError?: { code?: string; message?: string } }).stripeError;
      return {
        providerTransactionId: input.providerTransactionId,
        status: 'FAILED',
        failureCode: stripeErr?.code ?? 'card_declined',
        failureMessage:
          stripeErr?.message ?? (err instanceof Error ? err.message : 'Payment attempt declined'),
        rawResponse: { error: String(err) },
      };
    }
  }

  /**
   * Verifies Stripe webhook HMAC signature header (stripe-signature: t=timestamp,v1=signature).
   * Rejects signatures outside the configured timestamp tolerance (default 300s).
   * Also accepts plain HMAC-SHA256 hex if passed directly.
   */
  verifyWebhookSignature(
    rawBody: string,
    signature: string,
    secret?: string,
    toleranceSeconds?: number,
  ): boolean {
    const key = secret || this.webhookSecret;
    if (!signature || !key || !rawBody) {
      return false;
    }

    const maxTolerance = toleranceSeconds ?? this.webhookToleranceSeconds;

    try {
      // Check if Stripe timestamp format: t=...,v1=...
      if (signature.includes('t=') && signature.includes('v1=')) {
        const parts = signature.split(',').reduce(
          (acc, item) => {
            const [k, v] = item.split('=');
            if (k && v) acc[k.trim()] = v.trim();
            return acc;
          },
          {} as Record<string, string>,
        );

        const timestamp = parts['t'];
        const sigV1 = parts['v1'];
        if (!timestamp || !sigV1) return false;

        const timestampNum = parseInt(timestamp, 10);
        if (Number.isNaN(timestampNum)) return false;

        // Reject signatures when timestamp is outside allowed tolerance
        if (maxTolerance > 0) {
          const nowSeconds = Math.floor(Date.now() / 1000);
          if (Math.abs(nowSeconds - timestampNum) > maxTolerance) {
            this.logger.warn('Stripe webhook rejected: timestamp outside allowed tolerance', {
              webhookTimestamp: timestampNum,
              currentTimestamp: nowSeconds,
              toleranceSeconds: maxTolerance,
            });
            return false;
          }
        }

        const payloadToSign = `${timestamp}.${rawBody}`;
        const expected = createHmac('sha256', key).update(payloadToSign).digest('hex');

        const expectedBuf = Buffer.from(expected, 'hex');
        const sigBuf = Buffer.from(sigV1, 'hex');

        if (expectedBuf.length !== sigBuf.length) return false;
        return timingSafeEqual(expectedBuf, sigBuf);
      }

      // Plain HMAC hex format fallback
      const cleanSig = signature.startsWith('sha256=') ? signature.slice(7) : signature;
      const expectedHex = createHmac('sha256', key).update(rawBody).digest('hex');
      const expBuf = Buffer.from(expectedHex, 'hex');
      const actualBuf = Buffer.from(cleanSig, 'hex');

      if (expBuf.length !== actualBuf.length) return false;
      return timingSafeEqual(expBuf, actualBuf);
    } catch {
      return false;
    }
  }

  parseWebhookEvent(rawBody: string): ProviderWebhookEvent {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const providerEventId = String(parsed['id'] ?? parsed['eventId'] ?? `evt_${randomUUID()}`);
    const eventType = String(parsed['type'] ?? parsed['eventType'] ?? 'unknown');
    const dataObj = ((parsed['data'] as Record<string, unknown> | undefined)?.['object'] ??
      parsed['data'] ??
      parsed) as Record<string, unknown>;

    const meta = (dataObj['metadata'] as Record<string, unknown> | undefined) ?? {};
    const paymentIntentId = (meta['paymentIntentId'] || meta['internalIntentId']) as
      string | undefined;
    const providerTransactionId = String(dataObj['id'] ?? dataObj['providerTransactionId'] ?? '');

    const rawAmount = typeof dataObj['amount'] === 'number' ? dataObj['amount'] : undefined;
    const currency =
      typeof dataObj['currency'] === 'string'
        ? String(dataObj['currency']).toUpperCase()
        : undefined;
    const decimalAmount =
      rawAmount !== undefined ? fromStripeAmount(rawAmount, currency) : undefined;

    let status: 'SUCCEEDED' | 'FAILED' | undefined;
    if (
      eventType === 'payment_intent.succeeded' ||
      dataObj['status'] === 'succeeded' ||
      dataObj['status'] === 'SUCCEEDED'
    ) {
      status = 'SUCCEEDED';
    } else if (
      eventType === 'payment_intent.payment_failed' ||
      dataObj['status'] === 'requires_payment_method' ||
      dataObj['status'] === 'FAILED'
    ) {
      status = 'FAILED';
    }

    const lastErr = dataObj['last_payment_error'] as Record<string, unknown> | undefined;
    const failureReason = lastErr?.['message'] ? String(lastErr['message']) : undefined;

    return {
      providerEventId,
      eventType,
      paymentIntentId,
      providerTransactionId,
      amount: decimalAmount,
      currency,
      status,
      failureReason,
      rawPayload: parsed,
    };
  }

  async createRefund(input: ProviderRefundInput): Promise<ProviderRefundResult> {
    const stripeAmount = toStripeAmount(input.amount, input.currency);
    const data = await this.requestStripe<{
      id: string;
      status: string;
    }>(
      '/refunds',
      {
        payment_intent: input.providerTransactionId,
        amount: stripeAmount,
        reason: input.reason ?? 'requested_by_customer',
      },
      input.idempotencyKey,
    );

    return {
      providerRefundId: data.id,
      status: data.status === 'succeeded' ? 'SUCCEEDED' : 'PENDING',
      rawResponse: data as unknown as Record<string, unknown>,
    };
  }
}
