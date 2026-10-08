import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

export interface ProviderCreateIntentInput {
  amount: number;
  currency: string;
  metadata?: Record<string, unknown> | undefined;
  idempotencyKey?: string | null | undefined;
}

export interface ProviderIntentResult {
  providerTransactionId: string;
  clientSecret: string;
  status: 'CREATED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  rawResponse?: Record<string, unknown> | undefined;
}

export interface ProviderCreateAttemptInput {
  providerTransactionId: string;
  amount: number;
  currency: string;
  paymentMethod?: string | undefined;
  idempotencyKey?: string | null | undefined;
}

export interface ProviderAttemptResult {
  providerTransactionId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'REQUIRES_ACTION';
  failureCode?: string | undefined;
  failureMessage?: string | undefined;
  rawResponse?: Record<string, unknown> | undefined;
}

export interface ProviderWebhookEvent {
  providerEventId: string;
  eventType: string;
  paymentIntentId?: string | undefined;
  providerTransactionId?: string | undefined;
  amount?: number | undefined;
  currency?: string | undefined;
  status?: 'SUCCEEDED' | 'FAILED' | undefined;
  failureReason?: string | undefined;
  rawPayload: Record<string, unknown>;
}

export interface ProviderRefundInput {
  providerTransactionId: string;
  amount: number;
  currency: string;
  reason?: string | undefined;
  idempotencyKey?: string | null | undefined;
}

export interface ProviderRefundResult {
  providerRefundId: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  rawResponse?: Record<string, unknown> | undefined;
}

export interface PaymentProvider {
  readonly name: string;
  createIntent(input: ProviderCreateIntentInput): Promise<ProviderIntentResult>;
  createAttempt(input: ProviderCreateAttemptInput): Promise<ProviderAttemptResult>;
  verifyWebhookSignature(rawBody: string, signature: string, secret?: string, toleranceSeconds?: number): boolean;
  parseWebhookEvent(rawBody: string): ProviderWebhookEvent;
  createRefund(input: ProviderRefundInput): Promise<ProviderRefundResult>;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  async createIntent(input: ProviderCreateIntentInput): Promise<ProviderIntentResult> {
    const txnId = `txn_mock_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const secret = `pi_mock_sec_${randomUUID().replace(/-/g, '')}`;

    return {
      providerTransactionId: txnId,
      clientSecret: secret,
      status: 'CREATED',
      rawResponse: {
        provider: 'mock',
        amount: input.amount,
        currency: input.currency,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    };
  }

  async createAttempt(input: ProviderCreateAttemptInput): Promise<ProviderAttemptResult> {
    // Deterministic test triggers:
    const isDeclined =
      input.paymentMethod === 'pm_card_declined' ||
      input.paymentMethod?.toLowerCase().includes('fail') ||
      input.paymentMethod?.toLowerCase().includes('decline');

    if (
      input.paymentMethod === 'pm_card_threeDSecure2Required' ||
      input.paymentMethod?.toLowerCase().includes('3ds') ||
      input.paymentMethod?.toLowerCase().includes('action')
    ) {
      return {
        providerTransactionId: input.providerTransactionId,
        status: 'REQUIRES_ACTION',
        failureCode: 'requires_action',
        failureMessage: 'Cardholder action required (3DS / SCA)',
        rawResponse: {
          status: 'requires_action',
          client_secret: `pi_mock_sec_${input.providerTransactionId}`,
        },
      };
    }

    if (isDeclined) {
      return {
        providerTransactionId: input.providerTransactionId,
        status: 'FAILED',
        failureCode: 'card_declined',
        failureMessage: 'The payment card was declined by the simulated provider',
        rawResponse: {
          declineCode: 'generic_decline',
          attemptedAt: new Date().toISOString(),
        },
      };
    }

    return {
      providerTransactionId: input.providerTransactionId,
      status: 'SUCCEEDED',
      rawResponse: {
        networkTransactionId: `net_${randomUUID().slice(0, 12)}`,
        capturedAt: new Date().toISOString(),
      },
    };
  }

  verifyWebhookSignature(rawBody: string, signature: string, secret?: string, _toleranceSeconds?: number): boolean {
    if (!signature || !secret) {
      return false;
    }

    try {
      const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
      const sigBuf = Buffer.from(signature, 'utf8');
      const expBuf = Buffer.from(expected, 'utf8');

      if (sigBuf.length !== expBuf.length) {
        return false;
      }

      return timingSafeEqual(sigBuf, expBuf);
    } catch {
      return false;
    }
  }

  parseWebhookEvent(rawBody: string): ProviderWebhookEvent {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;

    const providerEventId = String(parsed.id ?? parsed.eventId ?? `evt_${randomUUID()}`);
    const eventType = String(parsed.type ?? parsed.eventType ?? 'unknown');
    const data = (parsed.data ?? parsed) as Record<string, unknown>;

    return {
      providerEventId,
      eventType,
      paymentIntentId: data.paymentIntentId ? String(data.paymentIntentId) : undefined,
      providerTransactionId: data.providerTransactionId ? String(data.providerTransactionId) : undefined,
      amount: typeof data.amount === 'number' ? data.amount : undefined,
      currency: typeof data.currency === 'string' ? data.currency : undefined,
      status: data.status === 'SUCCEEDED' || data.status === 'FAILED' ? data.status : undefined,
      failureReason: data.failureReason ? String(data.failureReason) : undefined,
      rawPayload: parsed,
    };
  }

  async createRefund(input: ProviderRefundInput): Promise<ProviderRefundResult> {
    return {
      providerRefundId: `ref_mock_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      status: 'SUCCEEDED',
      rawResponse: {
        refundedAmount: input.amount,
        currency: input.currency,
        reason: input.reason ?? 'customer_requested',
      },
    };
  }
}
