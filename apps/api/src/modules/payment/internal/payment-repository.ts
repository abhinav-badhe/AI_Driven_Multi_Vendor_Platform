import type { DatabaseConnection } from '../../../infra/database/connection.js';

export type PaymentIntentStatus =
  | 'CREATED'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REQUIRES_PAYMENT_METHOD';

export type PaymentAttemptStatus = 'INITIATED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'REQUIRES_ACTION';

export type WebhookProcessStatus = 'PROCESSED' | 'FAILED' | 'IGNORED';

export type RefundStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export interface PaymentIntentRow {
  id: string;
  customer_tenant_id: string;
  checkout_session_id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  status: PaymentIntentStatus;
  provider: string;
  client_secret: string;
  idempotency_key: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface PaymentAttemptRow {
  id: string;
  payment_intent_id: string;
  provider: string;
  provider_transaction_id: string;
  amount: number;
  currency: string;
  status: PaymentAttemptStatus;
  failure_code: string | null;
  failure_message: string | null;
  provider_response: Record<string, unknown>;
  idempotency_key: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PaymentWebhookEventRow {
  id: string;
  provider: string;
  provider_event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  processed_at: Date;
  status: WebhookProcessStatus;
}

export interface PaymentRefundRow {
  id: string;
  payment_intent_id: string;
  payment_attempt_id: string | null;
  amount: number;
  currency: string;
  status: RefundStatus;
  provider_refund_id: string | null;
  reason: string | null;
  idempotency_key: string | null;
  created_at: Date;
  updated_at: Date;
}

export class PaymentRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async createPaymentIntent(data: {
    id: string;
    customerTenantId: string;
    checkoutSessionId: string;
    amount: number;
    currency: string;
    status?: PaymentIntentStatus | undefined;
    provider: string;
    clientSecret: string;
    idempotencyKey?: string | null | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<PaymentIntentRow> {
    const res = await this.db.query<PaymentIntentRow>(
      `INSERT INTO payment_intents (
        id, customer_tenant_id, checkout_session_id, amount, currency,
        status, provider, client_secret, idempotency_key, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, customer_tenant_id, checkout_session_id, order_id, amount, currency,
                status, provider, client_secret, idempotency_key, metadata, created_at, updated_at`,
      [
        data.id,
        data.customerTenantId,
        data.checkoutSessionId,
        data.amount,
        data.currency,
        data.status ?? 'CREATED',
        data.provider,
        data.clientSecret,
        data.idempotencyKey ?? null,
        JSON.stringify(data.metadata ?? {}),
      ],
    );
    return res.rows[0]!;
  }

  async findIntentById(id: string): Promise<PaymentIntentRow | null> {
    const res = await this.db.query<PaymentIntentRow>(
      `SELECT id, customer_tenant_id, checkout_session_id, order_id, amount, currency,
              status, provider, client_secret, idempotency_key, metadata, created_at, updated_at
       FROM payment_intents
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findIntentByIdempotency(
    customerTenantId: string,
    idempotencyKey: string,
  ): Promise<PaymentIntentRow | null> {
    const res = await this.db.query<PaymentIntentRow>(
      `SELECT id, customer_tenant_id, checkout_session_id, order_id, amount, currency,
              status, provider, client_secret, idempotency_key, metadata, created_at, updated_at
       FROM payment_intents
       WHERE customer_tenant_id = $1 AND idempotency_key = $2`,
      [customerTenantId, idempotencyKey],
    );
    return res.rows[0] ?? null;
  }

  async findIntentByCheckoutSession(checkoutSessionId: string): Promise<PaymentIntentRow | null> {
    const res = await this.db.query<PaymentIntentRow>(
      `SELECT id, customer_tenant_id, checkout_session_id, order_id, amount, currency,
              status, provider, client_secret, idempotency_key, metadata, created_at, updated_at
       FROM payment_intents
       WHERE checkout_session_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [checkoutSessionId],
    );
    return res.rows[0] ?? null;
  }

  async findIntentByProviderTransactionId(providerTxnId: string): Promise<PaymentIntentRow | null> {
    const res = await this.db.query<PaymentIntentRow>(
      `SELECT pi.id, pi.customer_tenant_id, pi.checkout_session_id, pi.order_id, pi.amount, pi.currency,
              pi.status, pi.provider, pi.client_secret, pi.idempotency_key, pi.metadata, pi.created_at, pi.updated_at
       FROM payment_intents pi
       WHERE (pi.metadata->>'providerTransactionId' = $1)
          OR pi.id IN (
            SELECT payment_intent_id FROM payment_attempts WHERE provider_transaction_id = $1
          )
       ORDER BY pi.created_at DESC
       LIMIT 1`,
      [providerTxnId],
    );
    return res.rows[0] ?? null;
  }

  async updateIntentStatus(
    id: string,
    expectedStatus: PaymentIntentStatus | PaymentIntentStatus[],
    newStatus: PaymentIntentStatus,
    extra?: {
      orderId?: string | undefined;
      metadata?: Record<string, unknown> | undefined;
    } | undefined,
  ): Promise<PaymentIntentRow | null> {
    const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    const params: unknown[] = [id, newStatus];

    let query = `UPDATE payment_intents SET status = $2, updated_at = CURRENT_TIMESTAMP`;

    if (extra?.orderId !== undefined) {
      params.push(extra.orderId);
      query += `, order_id = $${params.length}`;
    }
    if (extra?.metadata !== undefined) {
      params.push(JSON.stringify(extra.metadata));
      query += `, metadata = $${params.length}`;
    }

    const placeholders = allowed.map((s) => {
      params.push(s);
      return `$${params.length}`;
    }).join(', ');

    query += ` WHERE id = $1 AND status IN (${placeholders})
      RETURNING id, customer_tenant_id, checkout_session_id, order_id, amount, currency,
                status, provider, client_secret, idempotency_key, metadata, created_at, updated_at`;

    const res = await this.db.query<PaymentIntentRow>(query, params);
    return res.rows[0] ?? null;
  }

  async createPaymentAttempt(data: {
    id: string;
    paymentIntentId: string;
    provider: string;
    providerTransactionId: string;
    amount: number;
    currency: string;
    status: PaymentAttemptStatus;
    failureCode?: string | null | undefined;
    failureMessage?: string | null | undefined;
    providerResponse?: Record<string, unknown> | undefined;
    idempotencyKey?: string | null | undefined;
  }): Promise<PaymentAttemptRow> {
    const res = await this.db.query<PaymentAttemptRow>(
      `INSERT INTO payment_attempts (
        id, payment_intent_id, provider, provider_transaction_id, amount, currency,
        status, failure_code, failure_message, provider_response, idempotency_key
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, payment_intent_id, provider, provider_transaction_id, amount, currency,
                status, failure_code, failure_message, provider_response, idempotency_key, created_at, updated_at`,
      [
        data.id,
        data.paymentIntentId,
        data.provider,
        data.providerTransactionId,
        data.amount,
        data.currency,
        data.status,
        data.failureCode ?? null,
        data.failureMessage ?? null,
        JSON.stringify(data.providerResponse ?? {}),
        data.idempotencyKey ?? null,
      ],
    );
    return res.rows[0]!;
  }

  async findAttemptsByIntentId(intentId: string): Promise<PaymentAttemptRow[]> {
    const res = await this.db.query<PaymentAttemptRow>(
      `SELECT id, payment_intent_id, provider, provider_transaction_id, amount, currency,
              status, failure_code, failure_message, provider_response, idempotency_key, created_at, updated_at
       FROM payment_attempts
       WHERE payment_intent_id = $1
       ORDER BY created_at DESC`,
      [intentId],
    );
    return res.rows;
  }

  async findAttemptByIdempotency(
    paymentIntentId: string,
    idempotencyKey: string,
  ): Promise<PaymentAttemptRow | null> {
    const res = await this.db.query<PaymentAttemptRow>(
      `SELECT id, payment_intent_id, provider, provider_transaction_id, amount, currency,
              status, failure_code, failure_message, provider_response, idempotency_key, created_at, updated_at
       FROM payment_attempts
       WHERE payment_intent_id = $1 AND idempotency_key = $2`,
      [paymentIntentId, idempotencyKey],
    );
    return res.rows[0] ?? null;
  }

  async findWebhookEvent(
    provider: string,
    providerEventId: string,
  ): Promise<PaymentWebhookEventRow | null> {
    const res = await this.db.query<PaymentWebhookEventRow>(
      `SELECT id, provider, provider_event_id, event_type, payload, processed_at, status
       FROM payment_webhook_events
       WHERE provider = $1 AND provider_event_id = $2`,
      [provider, providerEventId],
    );
    return res.rows[0] ?? null;
  }

  async recordWebhookEvent(data: {
    id: string;
    provider: string;
    providerEventId: string;
    eventType: string;
    payload: Record<string, unknown>;
    status?: WebhookProcessStatus | undefined;
  }): Promise<PaymentWebhookEventRow | null> {
    const res = await this.db.query<PaymentWebhookEventRow>(
      `INSERT INTO payment_webhook_events (
        id, provider, provider_event_id, event_type, payload, status
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (provider, provider_event_id) DO NOTHING
      RETURNING id, provider, provider_event_id, event_type, payload, processed_at, status`,
      [
        data.id,
        data.provider,
        data.providerEventId,
        data.eventType,
        JSON.stringify(data.payload),
        data.status ?? 'PROCESSED',
      ],
    );
    return res.rows[0] ?? null;
  }

  async createRefund(data: {
    id: string;
    paymentIntentId: string;
    paymentAttemptId?: string | null | undefined;
    amount: number;
    currency: string;
    status: RefundStatus;
    providerRefundId?: string | null | undefined;
    reason?: string | null | undefined;
    idempotencyKey?: string | null | undefined;
  }): Promise<PaymentRefundRow> {
    const res = await this.db.query<PaymentRefundRow>(
      `INSERT INTO payment_refunds (
        id, payment_intent_id, payment_attempt_id, amount, currency,
        status, provider_refund_id, reason, idempotency_key
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, payment_intent_id, payment_attempt_id, amount, currency,
                status, provider_refund_id, reason, idempotency_key, created_at, updated_at`,
      [
        data.id,
        data.paymentIntentId,
        data.paymentAttemptId ?? null,
        data.amount,
        data.currency,
        data.status,
        data.providerRefundId ?? null,
        data.reason ?? null,
        data.idempotencyKey ?? null,
      ],
    );
    return res.rows[0]!;
  }

  async findRefundsByIntentId(paymentIntentId: string): Promise<PaymentRefundRow[]> {
    const res = await this.db.query<PaymentRefundRow>(
      `SELECT id, payment_intent_id, payment_attempt_id, amount, currency,
              status, provider_refund_id, reason, idempotency_key, created_at, updated_at
       FROM payment_refunds
       WHERE payment_intent_id = $1
       ORDER BY created_at DESC`,
      [paymentIntentId],
    );
    return res.rows;
  }

  async findRefundByIdempotency(
    paymentIntentId: string,
    idempotencyKey: string,
  ): Promise<PaymentRefundRow | null> {
    const res = await this.db.query<PaymentRefundRow>(
      `SELECT id, payment_intent_id, payment_attempt_id, amount, currency,
              status, provider_refund_id, reason, idempotency_key, created_at, updated_at
       FROM payment_refunds
       WHERE payment_intent_id = $1 AND idempotency_key = $2`,
      [paymentIntentId, idempotencyKey],
    );
    return res.rows[0] ?? null;
  }

  async findRefundByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PaymentRefundRow | null> {
    const res = await this.db.query<PaymentRefundRow>(
      `SELECT id, payment_intent_id, payment_attempt_id, amount, currency,
              status, provider_refund_id, reason, idempotency_key, created_at, updated_at
       FROM payment_refunds
       WHERE idempotency_key = $1
       LIMIT 1`,
      [idempotencyKey],
    );
    return res.rows[0] ?? null;
  }

  async findRefundById(id: string): Promise<PaymentRefundRow | null> {
    const res = await this.db.query<PaymentRefundRow>(
      `SELECT id, payment_intent_id, payment_attempt_id, amount, currency,
              status, provider_refund_id, reason, idempotency_key, created_at, updated_at
       FROM payment_refunds
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findAllIntents(limit = 100): Promise<PaymentIntentRow[]> {
    const res = await this.db.query<PaymentIntentRow>(
      `SELECT id, customer_tenant_id, checkout_session_id, order_id, amount, currency,
              status, provider, client_secret, idempotency_key, metadata, created_at, updated_at
       FROM payment_intents
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return res.rows;
  }
}

