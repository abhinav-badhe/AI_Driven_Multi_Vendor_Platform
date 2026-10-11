import { randomUUID } from 'node:crypto';
import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import { RbacPolicy } from '../../identity/rbac/policy.js';
import type {
  IPaymentService,
  CreatePaymentIntentInput,
  CreatePaymentAttemptInput,
  CreateRefundInput,
  PaymentIntentDto,
  PaymentAttemptDto,
  PaymentRefundDto,
  WebhookProcessResultDto,
} from './payment-models.js';
import {
  ValidationError,
  NotFoundError,
  InvalidStateTransitionError,
  ConflictError,
} from '../../../errors/app-error.js';
import { normalizePaymentMethod } from './payment-service.js';

/**
 * InMemoryPaymentStore - Zero-DB in-memory store for payment isolation and testing.
 */
export class InMemoryPaymentStore implements IPaymentService {
  private readonly intents = new Map<string, PaymentIntentDto>();
  private readonly attempts = new Map<string, PaymentAttemptDto[]>();
  private readonly refunds = new Map<string, PaymentRefundDto[]>();
  private readonly intentIdempotency = new Map<string, string>(); // tenantId:key -> intentId
  private readonly attemptIdempotency = new Map<string, string>(); // intentId:key -> attemptId
  private readonly processedWebhooks = new Set<string>();

  async createPaymentIntent(
    actor: AuthorizedActor,
    input: CreatePaymentIntentInput,
  ): Promise<PaymentIntentDto> {
    RbacPolicy.requirePermission(actor, 'payment:create-own');

    if (!input.checkoutSessionId) {
      throw new ValidationError('checkoutSessionId is required');
    }

    if (input.idempotencyKey) {
      const cacheKey = `${actor.tenantId}:${input.idempotencyKey}`;
      const existingId = this.intentIdempotency.get(cacheKey);
      if (existingId) {
        const existing = this.intents.get(existingId);
        if (existing) {
          if (existing.checkoutSessionId !== input.checkoutSessionId) {
            throw new ValidationError('Payment intent idempotency key reuse with different checkout session');
          }
          const atts = this.attempts.get(existing.id) ?? [];
          return { ...existing, attempts: atts };
        }
      }
    }

    const intentId = randomUUID();
    const now = new Date().toISOString();
    const dto: PaymentIntentDto = {
      id: intentId,
      customerTenantId: actor.tenantId,
      checkoutSessionId: input.checkoutSessionId,
      orderId: null,
      amount: 1000,
      currency: 'INR',
      status: 'CREATED',
      provider: 'mock',
      clientSecret: `sec_${intentId}`,
      idempotencyKey: input.idempotencyKey ?? null,
      metadata: input.metadata ?? {},
      paymentMethod: null,
      createdAt: now,
      updatedAt: now,
      attempts: [],
    };

    this.intents.set(intentId, dto);
    this.attempts.set(intentId, []);
    this.refunds.set(intentId, []);

    if (input.idempotencyKey) {
      this.intentIdempotency.set(`${actor.tenantId}:${input.idempotencyKey}`, intentId);
    }

    return dto;
  }

  async getPaymentIntent(actor: AuthorizedActor, id: string): Promise<PaymentIntentDto> {
    const intent = this.intents.get(id);
    if (!intent) {
      throw new NotFoundError(`Payment intent '${id}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'payment:read-own');
      RbacPolicy.requireTenantMatch(actor, intent.customerTenantId);
    }

    const atts = this.attempts.get(id) ?? [];
    return { ...intent, attempts: atts };
  }

  async createPaymentAttempt(
    actor: AuthorizedActor,
    intentId: string,
    input: CreatePaymentAttemptInput,
  ): Promise<PaymentAttemptDto> {
    RbacPolicy.requirePermission(actor, 'payment:create-own');

    const intent = this.intents.get(intentId);
    if (!intent) {
      throw new NotFoundError(`Payment intent '${intentId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, intent.customerTenantId);
    }

    if (input.idempotencyKey) {
      const cacheKey = `${intentId}:${input.idempotencyKey}`;
      const existingAttemptId = this.attemptIdempotency.get(cacheKey);
      if (existingAttemptId) {
        const atts = this.attempts.get(intentId) ?? [];
        const existing = atts.find((a) => a.id === existingAttemptId);
        if (existing) return existing;
      }
    }

    if (intent.status === 'SUCCEEDED') {
      const atts = this.attempts.get(intentId) ?? [];
      const successful = atts.find((a) => a.status === 'SUCCEEDED');
      if (successful) return successful;
      throw new InvalidStateTransitionError('Payment intent has already succeeded');
    }

    if (intent.status === 'CANCELLED' || intent.status === 'FAILED') {
      throw new InvalidStateTransitionError(
        `Cannot attempt payment for intent in status '${intent.status}'`,
      );
    }

    const now = new Date().toISOString();
    const isDeclined = input.paymentMethod?.toLowerCase().includes('declined') ?? false;
    const attemptStatus = isDeclined ? 'FAILED' : 'SUCCEEDED';
    const method = normalizePaymentMethod(input.paymentMethod);

    const attempt: PaymentAttemptDto = {
      id: randomUUID(),
      paymentIntentId: intentId,
      provider: intent.provider,
      providerTransactionId: `txn_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      amount: intent.amount,
      currency: intent.currency,
      status: attemptStatus,
      failureCode: isDeclined ? 'card_declined' : null,
      failureMessage: isDeclined ? 'Card was declined' : null,
      providerResponse: { status: attemptStatus },
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: now,
      updatedAt: now,
    };

    const atts = this.attempts.get(intentId) ?? [];
    atts.push(attempt);
    this.attempts.set(intentId, atts);

    if (input.idempotencyKey) {
      this.attemptIdempotency.set(`${intentId}:${input.idempotencyKey}`, attempt.id);
    }

    if (attemptStatus === 'SUCCEEDED') {
      intent.status = 'SUCCEEDED';
      intent.paymentMethod = method;
      intent.updatedAt = now;
      this.intents.set(intentId, intent);
    } else {
      intent.status = 'FAILED';
      intent.updatedAt = now;
      this.intents.set(intentId, intent);
    }

    return attempt;
  }

  async createRefund(
    actor: AuthorizedActor,
    intentId: string,
    input: CreateRefundInput,
  ): Promise<PaymentRefundDto> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'payment:manage-any');
    }

    const intent = this.intents.get(intentId);
    if (!intent) {
      throw new NotFoundError(`Payment intent '${intentId}' not found`);
    }

    if (intent.status !== 'SUCCEEDED') {
      throw new InvalidStateTransitionError(
        `Cannot refund intent in status '${intent.status}'. Intent must be SUCCEEDED.`,
      );
    }

    const refundAmount = input.amount ?? intent.amount;
    if (refundAmount <= 0) {
      throw new ValidationError('Refund amount must be greater than zero');
    }

    const existingRefunds = this.refunds.get(intentId) ?? [];
    if (input.idempotencyKey) {
      const existing = existingRefunds.find((r) => r.idempotencyKey === input.idempotencyKey);
      if (existing) return existing;
    }

    const totalRefunded = existingRefunds.reduce((sum, r) => sum + r.amount, 0);
    if (totalRefunded + refundAmount > intent.amount) {
      throw new ConflictError(
        `Cumulative refunds (${totalRefunded + refundAmount}) cannot exceed intent amount (${intent.amount})`,
      );
    }

    const now = new Date().toISOString();
    const refund: PaymentRefundDto = {
      id: randomUUID(),
      paymentIntentId: intentId,
      paymentAttemptId: null,
      amount: refundAmount,
      currency: intent.currency,
      status: 'SUCCEEDED',
      providerRefundId: `re_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      reason: input.reason ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: now,
      updatedAt: now,
    };

    existingRefunds.push(refund);
    this.refunds.set(intentId, existingRefunds);

    return refund;
  }

  async linkOrderToIntent(intentId: string, orderId: string): Promise<void> {
    const intent = this.intents.get(intentId);
    if (intent) {
      intent.orderId = orderId;
      this.intents.set(intentId, intent);
    }
  }

  async processWebhook(
    _providerName: string,
    rawPayload: string,
    signatureHeader: string,
  ): Promise<WebhookProcessResultDto> {
    if (!signatureHeader) {
      throw new ValidationError('Missing webhook signature header');
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(rawPayload);
    } catch {
      throw new ValidationError('Invalid JSON webhook payload');
    }

    const eventId = String(parsed.id ?? `evt_${randomUUID()}`);
    const eventType = String(parsed.type ?? 'payment_intent.succeeded');

    if (this.processedWebhooks.has(eventId)) {
      return {
        processed: true,
        duplicate: true,
        providerEventId: eventId,
        eventType,
      };
    }

    this.processedWebhooks.add(eventId);

    const intentId = parsed.paymentIntentId as string | undefined;
    if (intentId) {
      const intent = this.intents.get(intentId);
      if (intent) {
        if (eventType === 'payment_intent.succeeded' && intent.status !== 'SUCCEEDED') {
          intent.status = 'SUCCEEDED';
          intent.updatedAt = new Date().toISOString();
          this.intents.set(intentId, intent);
        } else if (eventType === 'payment_intent.payment_failed' && intent.status !== 'SUCCEEDED') {
          intent.status = 'FAILED';
          intent.updatedAt = new Date().toISOString();
          this.intents.set(intentId, intent);
        }
      }
    }

    return {
      processed: true,
      duplicate: false,
      providerEventId: eventId,
      eventType,
    };
  }

  // Testing helpers
  seedPaymentIntent(intent: PaymentIntentDto): void {
    this.intents.set(intent.id, intent);
    if (intent.idempotencyKey) {
      this.intentIdempotency.set(`${intent.customerTenantId}:${intent.idempotencyKey}`, intent.id);
    }
    if (intent.attempts) {
      this.attempts.set(intent.id, [...intent.attempts]);
    }
  }

  async listAllPayments(actor: AuthorizedActor): Promise<PaymentIntentDto[]> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'payment:manage-any');
    }
    return Array.from(this.intents.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  seedPaymentAttempt(attempt: PaymentAttemptDto): void {
    const atts = this.attempts.get(attempt.paymentIntentId) ?? [];
    atts.push(attempt);
    this.attempts.set(attempt.paymentIntentId, atts);
  }

  clear(): void {
    this.intents.clear();
    this.attempts.clear();
    this.refunds.clear();
    this.intentIdempotency.clear();
    this.attemptIdempotency.clear();
    this.processedWebhooks.clear();
  }
}
