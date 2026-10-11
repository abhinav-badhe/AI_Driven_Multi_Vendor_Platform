import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type {
  PaymentIntentStatus,
  PaymentAttemptStatus,
  RefundStatus,
  WebhookProcessStatus,
} from './payment-repository.js';

export type {
  PaymentIntentStatus,
  PaymentAttemptStatus,
  RefundStatus,
  WebhookProcessStatus,
};

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

export interface WebhookProcessResultDto {
  processed: boolean;
  duplicate: boolean;
  providerEventId: string;
  eventType: string;
}

/**
 * IPaymentReader - Decoupled interface for downstream domains (e.g. Orders).
 */
export interface IPaymentReader {
  getPaymentIntent(actor: AuthorizedActor, id: string): Promise<PaymentIntentDto>;
  linkOrderToIntent(intentId: string, orderId: string): Promise<void>;
}

/**
 * IPaymentService - Full payment lifecycle management interface.
 * Implemented by PaymentService (SQL), InMemoryPaymentStore, and HttpPaymentClient.
 */
export interface IPaymentService extends IPaymentReader {
  createPaymentIntent(
    actor: AuthorizedActor,
    input: CreatePaymentIntentInput,
  ): Promise<PaymentIntentDto>;

  createPaymentAttempt(
    actor: AuthorizedActor,
    intentId: string,
    input: CreatePaymentAttemptInput,
  ): Promise<PaymentAttemptDto>;

  createRefund(
    actor: AuthorizedActor,
    intentId: string,
    input: CreateRefundInput,
  ): Promise<PaymentRefundDto>;

  listAllPayments(actor: AuthorizedActor): Promise<PaymentIntentDto[]>;

  processWebhook(
    providerName: string,
    rawPayload: string,
    signatureHeader: string,
  ): Promise<WebhookProcessResultDto>;
}

