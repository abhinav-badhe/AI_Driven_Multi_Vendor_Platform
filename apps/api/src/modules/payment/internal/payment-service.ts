import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import {
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';
import { RbacPolicy, type AuthorizedActor } from '../../identity/rbac/policy.js';
import type { CheckoutService, ICheckoutReader } from '../../cart-checkout/index.js';
import { OutboxService, EventTypes, createDomainEvent } from '../../events/index.js';
import {
  PaymentRepository,
  type PaymentIntentRow,
  type PaymentAttemptRow,
  type PaymentRefundRow,
  type PaymentIntentStatus,
  type PaymentAttemptStatus,
  type RefundStatus,
} from './payment-repository.js';
import {
  type PaymentProvider,
  MockPaymentProvider,
  type ProviderWebhookEvent,
} from './payment-provider.js';

export interface CreatePaymentIntentInput {
  checkoutSessionId: string;
  idempotencyKey?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface CreatePaymentAttemptInput {
  paymentMethod?: string | undefined;
  idempotencyKey?: string | null | undefined;
}

export interface CreateRefundInput {
  amount?: number | undefined;
  reason?: string | undefined;
  idempotencyKey?: string | null | undefined;
}

export interface PaymentIntentDto {
  id: string;
  customerTenantId: string;
  checkoutSessionId: string;
  orderId: string | null;
  amount: number;
  currency: string;
  status: PaymentIntentStatus;
  provider: string;
  clientSecret: string;
  idempotencyKey: string | null;
  metadata: Record<string, unknown>;
  paymentMethod: 'COD' | 'UPI' | 'CARD' | null;
  createdAt: string;
  updatedAt: string;
  attempts?: PaymentAttemptDto[] | undefined;
}

/**
 * Normalizes provider method strings into settlement-facing methods.
 * 'cod' means cash is collected on delivery — no online capture happens.
 */
export function normalizePaymentMethod(input?: string | null): 'COD' | 'UPI' | 'CARD' {
  const v = (input ?? '').toLowerCase();
  if (v === 'cod' || v === 'cash' || v.includes('cash_on_delivery')) return 'COD';
  if (v.includes('upi')) return 'UPI';
  return 'CARD';
}

export function paymentMethodFromMetadata(metadata: unknown): 'COD' | 'UPI' | 'CARD' | null {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const v = (metadata as Record<string, unknown>).paymentMethod;
    if (v === 'COD' || v === 'UPI' || v === 'CARD') return v;
  }
  return null;
}

export interface PaymentAttemptDto {
  id: string;
  paymentIntentId: string;
  provider: string;
  providerTransactionId: string;
  amount: number;
  currency: string;
  status: PaymentAttemptStatus;
  failureCode: string | null;
  failureMessage: string | null;
  providerResponse: Record<string, unknown>;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentRefundDto {
  id: string;
  paymentIntentId: string;
  paymentAttemptId: string | null;
  amount: number;
  currency: string;
  status: RefundStatus;
  providerRefundId: string | null;
  reason: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}

import type { IPaymentService, WebhookProcessResultDto } from './payment-models.js';
export type { WebhookProcessResultDto };

export class PaymentService implements IPaymentService {
  private readonly repo: PaymentRepository;
  private readonly provider: PaymentProvider;
  private readonly webhookSecret: string;
  private readonly db: DatabaseConnection;

  constructor(
    db: DatabaseConnection,
    private readonly logger: Logger,
    private readonly checkoutService: ICheckoutReader | CheckoutService,
    private readonly outboxService: OutboxService,
    provider?: PaymentProvider,
    webhookSecret = 'whsec_mock_default_secret_for_tests',
    private readonly webhookToleranceSeconds = 300,
  ) {
    this.repo = new PaymentRepository(db);
    this.provider = provider ?? new MockPaymentProvider();
    this.webhookSecret = webhookSecret;
    this.db = db;
  }

  getProvider(): PaymentProvider {
    return this.provider;
  }

  getWebhookSecret(): string {
    return this.webhookSecret;
  }

  async createPaymentIntent(
    actor: AuthorizedActor,
    input: CreatePaymentIntentInput,
  ): Promise<PaymentIntentDto> {
    RbacPolicy.requirePermission(actor, 'payment:create-own');

    const checkout = await this.checkoutService.getCheckoutSession(actor, input.checkoutSessionId);
    if (!checkout) {
      throw new NotFoundError(`Checkout session '${input.checkoutSessionId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, checkout.customerTenantId);
    }

    // Checkout must be in READY status to accept payment intent
    if (checkout.status !== 'READY' && checkout.status !== 'RESERVED') {
      throw new InvalidStateTransitionError(
        `Cannot create payment intent: checkout session '${checkout.id}' is in status '${checkout.status}'. Expected 'READY'.`,
      );
    }

    if (new Date(checkout.expiresAt).getTime() <= Date.now()) {
      throw new InvalidStateTransitionError('Checkout session has expired');
    }

    const amount = checkout.totalAmount;
    const currency = checkout.currency;

    if (amount <= 0) {
      throw new ValidationError('Checkout total amount must be greater than zero');
    }

    // Idempotency verification:
    if (input.idempotencyKey) {
      const existing = await this.repo.findIntentByIdempotency(actor.tenantId, input.idempotencyKey);
      if (existing) {
        if (
          existing.amount !== amount ||
          existing.currency !== currency ||
          existing.checkout_session_id !== checkout.id
        ) {
          throw new ValidationError(
            `Payment intent idempotency key reuse with different amount, currency, or checkout session. Expected ${existing.amount} ${existing.currency} for checkout ${existing.checkout_session_id}, got ${amount} ${currency} for checkout ${checkout.id}`,
          );
        }
        const attempts = await this.repo.findAttemptsByIntentId(existing.id);
        return this.toIntentDto(existing, attempts);
      }
    }

    // Check if an intent already exists for this exact checkout session
    const existingSessionIntent = await this.repo.findIntentByCheckoutSession(checkout.id);
    if (existingSessionIntent && existingSessionIntent.status === 'SUCCEEDED') {
      const attempts = await this.repo.findAttemptsByIntentId(existingSessionIntent.id);
      return this.toIntentDto(existingSessionIntent, attempts);
    }

    const intentId = randomUUID();

    // Call provider
    const providerResult = await this.provider.createIntent({
      amount,
      currency,
      metadata: {
        ...(input.metadata ?? {}),
        internalIntentId: intentId,
        paymentIntentId: intentId,
      },
      idempotencyKey: input.idempotencyKey,
    });

    let row: PaymentIntentRow;
    try {
      row = await this.repo.createPaymentIntent({
        id: intentId,
        customerTenantId: actor.tenantId,
        checkoutSessionId: checkout.id,
        amount,
        currency,
        status: 'CREATED',
        provider: this.provider.name,
        clientSecret: providerResult.clientSecret,
        idempotencyKey: input.idempotencyKey ?? null,
        metadata: {
          ...(input.metadata ?? {}),
          providerTransactionId: providerResult.providerTransactionId,
        },
      });
    } catch (err: unknown) {
      // Idempotency race conflict recovery
      if (
        input.idempotencyKey &&
        (err instanceof Error &&
          (err.message.includes('uq_payment_intent_idempotency') ||
            (err as { code?: string }).code === '23505'))
      ) {
        const existing = await this.repo.findIntentByIdempotency(actor.tenantId, input.idempotencyKey);
        if (existing) {
          if (
            existing.amount !== amount ||
            existing.currency !== currency ||
            existing.checkout_session_id !== checkout.id
          ) {
            throw new ValidationError(
              `Payment intent idempotency key reuse with different amount, currency, or checkout session.`,
            );
          }
          const attempts = await this.repo.findAttemptsByIntentId(existing.id);
          return this.toIntentDto(existing, attempts);
        }
      }
      throw err;
    }

    return this.toIntentDto(row, []);
  }

  async getPaymentIntent(actor: AuthorizedActor, id: string): Promise<PaymentIntentDto> {
    const row = await this.repo.findIntentById(id);
    if (!row) {
      throw new NotFoundError(`Payment intent '${id}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'payment:read-own');
      RbacPolicy.requireTenantMatch(actor, row.customer_tenant_id);
    }

    const attempts = await this.repo.findAttemptsByIntentId(row.id);
    return this.toIntentDto(row, attempts);
  }

  async createPaymentAttempt(
    actor: AuthorizedActor,
    intentId: string,
    input: CreatePaymentAttemptInput,
  ): Promise<PaymentAttemptDto> {
    RbacPolicy.requirePermission(actor, 'payment:create-own');

    const intent = await this.repo.findIntentById(intentId);
    if (!intent) {
      throw new NotFoundError(`Payment intent '${intentId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, intent.customer_tenant_id);
    }

    // Idempotency check for payment attempt
    if (input.idempotencyKey) {
      const existing = await this.repo.findAttemptByIdempotency(intentId, input.idempotencyKey);
      if (existing) {
        if (existing.amount !== intent.amount || existing.currency !== intent.currency) {
          throw new ValidationError(
            `Payment attempt idempotency key reuse with different amount or currency. Expected ${existing.amount} ${existing.currency}, got ${intent.amount} ${intent.currency}`,
          );
        }
        return this.toAttemptDto(existing);
      }
    }

    if (intent.status === 'SUCCEEDED') {
      // Intent already succeeded; do not create duplicate success attempts
      const attempts = await this.repo.findAttemptsByIntentId(intentId);
      const successful = attempts.find((a) => a.status === 'SUCCEEDED');
      if (successful) {
        return this.toAttemptDto(successful);
      }
      throw new InvalidStateTransitionError('Payment intent has already succeeded');
    }

    if (intent.status === 'CANCELLED' || intent.status === 'FAILED') {
      throw new InvalidStateTransitionError(
        `Cannot attempt payment for intent in status '${intent.status}'`,
      );
    }

    // Transition intent to PROCESSING
    await this.repo.updateIntentStatus(intent.id, ['CREATED', 'PROCESSING', 'REQUIRES_PAYMENT_METHOD'], 'PROCESSING');

    // Call Provider
    const providerTxnId =
      (intent.metadata?.providerTransactionId as string | undefined) ??
      `txn_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    const providerResult = await this.provider.createAttempt({
      providerTransactionId: providerTxnId,
      amount: intent.amount,
      currency: intent.currency,
      paymentMethod: input.paymentMethod,
      idempotencyKey: input.idempotencyKey,
    });

    const attemptId = randomUUID();
    let attemptRow: PaymentAttemptRow;

    const dbAttemptStatus: PaymentAttemptStatus =
      providerResult.status === 'REQUIRES_ACTION' ? 'PROCESSING' : providerResult.status;

    try {
      attemptRow = await this.repo.createPaymentAttempt({
        id: attemptId,
        paymentIntentId: intent.id,
        provider: this.provider.name,
        providerTransactionId: providerResult.providerTransactionId,
        amount: intent.amount,
        currency: intent.currency,
        status: dbAttemptStatus,
        failureCode: providerResult.status === 'REQUIRES_ACTION' ? 'requires_action' : providerResult.failureCode,
        failureMessage:
          providerResult.status === 'REQUIRES_ACTION'
            ? 'Cardholder action required (3DS / SCA)'
            : providerResult.failureMessage,
        providerResponse: {
          ...(providerResult.rawResponse ?? {}),
          status: providerResult.status === 'REQUIRES_ACTION' ? 'requires_action' : providerResult.status,
        },
        idempotencyKey: input.idempotencyKey ?? null,
      });
    } catch (err: unknown) {
      if (
        input.idempotencyKey &&
        (err instanceof Error &&
          (err.message.includes('uq_payment_attempt_idempotency') ||
            (err as { code?: string }).code === '23505'))
      ) {
        const existing = await this.repo.findAttemptByIdempotency(intent.id, input.idempotencyKey);
        if (existing) {
          if (existing.amount !== intent.amount || existing.currency !== intent.currency) {
            throw new ValidationError(
              `Payment attempt idempotency key reuse with different amount or currency.`,
            );
          }
          return this.toAttemptDto(existing);
        }
      }
      throw err;
    }

    // Update parent intent status based on attempt result
    if (providerResult.status === 'SUCCEEDED') {
      const method = normalizePaymentMethod(input.paymentMethod);
      const currentMeta =
        intent.metadata && typeof intent.metadata === 'object' ? intent.metadata : {};

      await this.db.withTransaction(async (tx) => {
        const txRepo = new PaymentRepository(tx);
        await txRepo.updateIntentStatus(
          intent.id,
          ['CREATED', 'PROCESSING', 'REQUIRES_PAYMENT_METHOD'],
          'SUCCEEDED',
          {
            metadata: { ...currentMeta, paymentMethod: method },
          },
        );

        await this.outboxService.recordEvent(
          tx,
          createDomainEvent({
            eventType: EventTypes.PAYMENT_SUCCEEDED,
            aggregateType: 'PaymentIntent',
            aggregateId: intent.id,
            tenantId: intent.customer_tenant_id,
            payload: {
              checkoutSessionId: intent.checkout_session_id,
              amount: intent.amount,
              currency: intent.currency,
              paymentMethod: method,
            },
          }),
        );
      });
    } else if (providerResult.status === 'REQUIRES_ACTION') {
      await this.repo.updateIntentStatus(intent.id, ['CREATED', 'PROCESSING'], 'PROCESSING', {
        metadata: {
          requiresAction: true,
          clientSecret: intent.client_secret,
        },
      });
    } else {
      await this.repo.updateIntentStatus(intent.id, 'PROCESSING', 'FAILED', {
        metadata: {
          lastFailureCode: providerResult.failureCode,
          lastFailureMessage: providerResult.failureMessage,
        },
      });
    }

    return this.toAttemptDto(attemptRow);
  }

  async processWebhook(
    providerName: string,
    rawBody: string,
    signatureHeader: string,
  ): Promise<WebhookProcessResultDto> {
    // 1. Signature Verification with Timestamp Tolerance
    const isValid = this.provider.verifyWebhookSignature(
      rawBody,
      signatureHeader,
      this.webhookSecret,
      this.webhookToleranceSeconds,
    );
    if (!isValid) {
      this.logger.warn('Rejected payment webhook due to invalid signature', { providerName });
      throw new UnauthorizedError('Invalid payment webhook signature');
    }

    // 2. Parse Event
    let event: ProviderWebhookEvent;
    try {
      event = this.provider.parseWebhookEvent(rawBody);
    } catch {
      throw new ValidationError('Malformed payment webhook payload');
    }

    // 3. Replay Protection / Deduplication
    const existing = await this.repo.findWebhookEvent(providerName, event.providerEventId);
    if (existing) {
      this.logger.info('Deduplicated already-processed payment webhook event', {
        providerEventId: event.providerEventId,
      });
      return {
        processed: true,
        duplicate: true,
        providerEventId: event.providerEventId,
        eventType: event.eventType,
      };
    }

    // 4 & 5. Handle Event Transitions and Persist in Deduplication Ledger ATOMICALLY
    return this.db.withTransaction(async (tx) => {
      const txRepo = new PaymentRepository(tx);
      let intent: PaymentIntentRow | null = null;
      if (event.paymentIntentId) {
        intent = await txRepo.findIntentById(event.paymentIntentId);
      }
      if (!intent && event.providerTransactionId) {
        intent = await txRepo.findIntentByProviderTransactionId(event.providerTransactionId);
      }

      if (intent) {
          if (event.eventType === 'payment_intent.succeeded' || event.status === 'SUCCEEDED') {
            if (intent.status !== 'SUCCEEDED') {
              await txRepo.updateIntentStatus(intent.id, ['CREATED', 'PROCESSING'], 'SUCCEEDED');
              
              await this.outboxService.recordEvent(tx, createDomainEvent({
                eventType: EventTypes.PAYMENT_SUCCEEDED,
                aggregateType: 'PaymentIntent',
                aggregateId: intent.id,
                tenantId: intent.customer_tenant_id,
                payload: {
                  checkoutSessionId: intent.checkout_session_id,
                  amount: intent.amount,
                  currency: intent.currency,
                },
              }));
            }
          } else if (event.eventType === 'payment_intent.payment_failed' || event.status === 'FAILED') {
            if (intent.status !== 'SUCCEEDED') {
              await txRepo.updateIntentStatus(intent.id, ['CREATED', 'PROCESSING'], 'FAILED', {
                metadata: { failureReason: event.failureReason ?? 'Webhook reported payment failure' },
              });
            }
          }
      }

      const webhookRowId = randomUUID();
      try {
        const recorded = await txRepo.recordWebhookEvent({
          id: webhookRowId,
          provider: providerName,
          providerEventId: event.providerEventId,
          eventType: event.eventType,
          payload: event.rawPayload,
          status: 'PROCESSED',
        });
        if (!recorded) {
          return {
            processed: true,
            duplicate: true,
            providerEventId: event.providerEventId,
            eventType: event.eventType,
          };
        }
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          (err.message.includes('uq_webhook_provider_event') ||
            (err as { code?: string }).code === '23505')
        ) {
          return {
            processed: true,
            duplicate: true,
            providerEventId: event.providerEventId,
            eventType: event.eventType,
          };
        }
        throw err;
      }

      return {
        processed: true,
        duplicate: false,
        providerEventId: event.providerEventId,
        eventType: event.eventType,
      };
    });
  }

  async createRefund(
    actor: AuthorizedActor,
    intentId: string,
    input: CreateRefundInput,
  ): Promise<PaymentRefundDto> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'payment:manage-any');
    }

    const intent = await this.repo.findIntentById(intentId);
    if (!intent) {
      throw new NotFoundError(`Payment intent '${intentId}' not found`);
    }

    if (intent.status !== 'SUCCEEDED') {
      throw new InvalidStateTransitionError(
        `Cannot refund payment intent in status '${intent.status}'. Only SUCCEEDED payments can be refunded.`,
      );
    }

    const refundAmount = input.amount ?? intent.amount;
    if (refundAmount <= 0 || refundAmount > intent.amount) {
      throw new ValidationError(
        `Refund amount must be between 1 and ${intent.amount} ${intent.currency}`,
      );
    }

    // Idempotency check: verify key globally to reject reuse with different payment intents
    if (input.idempotencyKey) {
      const existing = await this.repo.findRefundByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        if (existing.payment_intent_id !== intentId) {
          throw new ValidationError(
            `Refund idempotency key '${input.idempotencyKey}' reuse with different payment intent.`,
          );
        }
        if (existing.amount !== refundAmount || existing.currency !== intent.currency) {
          throw new ValidationError(
            `Refund idempotency key reuse with different amount or currency. Expected ${existing.amount} ${existing.currency}, got ${refundAmount} ${intent.currency}`,
          );
        }
        return this.toRefundDto(existing);
      }
    }

    const attempts = await this.repo.findAttemptsByIntentId(intentId);
    const successfulAttempt = attempts.find((a) => a.status === 'SUCCEEDED');

    const providerResult = await this.provider.createRefund({
      providerTransactionId: successfulAttempt?.provider_transaction_id ?? intent.id,
      amount: refundAmount,
      currency: intent.currency,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });

    const refundId = randomUUID();
    let refundRow: PaymentRefundRow;

    try {
      refundRow = await this.repo.createRefund({
        id: refundId,
        paymentIntentId: intent.id,
        paymentAttemptId: successfulAttempt?.id ?? null,
        amount: refundAmount,
        currency: intent.currency,
        status: providerResult.status,
        providerRefundId: providerResult.providerRefundId,
        reason: input.reason ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      });
    } catch (err: unknown) {
      if (
        input.idempotencyKey &&
        (err instanceof Error &&
          (err.message.includes('uq_refund') ||
            (err as { code?: string }).code === '23505'))
      ) {
        const existing = await this.repo.findRefundByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          if (existing.payment_intent_id !== intentId) {
            throw new ValidationError(
              `Refund idempotency key '${input.idempotencyKey}' reuse with different payment intent.`,
            );
          }
          if (existing.amount !== refundAmount || existing.currency !== intent.currency) {
            throw new ValidationError(
              `Refund idempotency key reuse with different amount or currency.`,
            );
          }
          return this.toRefundDto(existing);
        }
      }
      throw err;
    }

    return this.toRefundDto(refundRow);
  }

  async getRefund(actor: AuthorizedActor, refundId: string): Promise<PaymentRefundDto> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'payment:read-own');
    }
    const row = await this.repo.findRefundById(refundId);
    if (!row) {
      throw new NotFoundError(`Payment refund '${refundId}' not found`);
    }
    return this.toRefundDto(row);
  }

  // Internal helper for linking finalized order to intent
  async linkOrderToIntent(intentId: string, orderId: string): Promise<void> {
    await this.repo.updateIntentStatus(intentId, 'SUCCEEDED', 'SUCCEEDED', { orderId });
  }

  private toIntentDto(row: PaymentIntentRow, attempts: PaymentAttemptRow[] = []): PaymentIntentDto {
    return {
      id: row.id,
      customerTenantId: row.customer_tenant_id,
      checkoutSessionId: row.checkout_session_id,
      orderId: row.order_id,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      provider: row.provider,
      clientSecret: row.client_secret,
      idempotencyKey: row.idempotency_key,
      metadata: row.metadata,
      paymentMethod: paymentMethodFromMetadata(row.metadata),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      attempts: attempts.map((a) => this.toAttemptDto(a)),
    };
  }

  private toAttemptDto(row: PaymentAttemptRow): PaymentAttemptDto {
    const isRequiresAction =
      row.status === 'PROCESSING' &&
      (row.failure_code === 'requires_action' ||
        (row.provider_response as Record<string, unknown>)?.['status'] === 'requires_action');

    return {
      id: row.id,
      paymentIntentId: row.payment_intent_id,
      provider: row.provider,
      providerTransactionId: row.provider_transaction_id,
      amount: row.amount,
      currency: row.currency,
      status: isRequiresAction ? 'REQUIRES_ACTION' : row.status,
      failureCode: row.failure_code,
      failureMessage: row.failure_message,
      providerResponse: row.provider_response,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private toRefundDto(row: PaymentRefundRow): PaymentRefundDto {
    return {
      id: row.id,
      paymentIntentId: row.payment_intent_id,
      paymentAttemptId: row.payment_attempt_id,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      providerRefundId: row.provider_refund_id,
      reason: row.reason,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async listAllPayments(actor: AuthorizedActor): Promise<PaymentIntentDto[]> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'payment:manage-any');
    }
    const rows = await this.repo.findAllIntents();
    return rows.map((r: PaymentIntentRow) => this.toIntentDto(r));
  }
}

