import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { CheckoutService } from '../cart-checkout/index.js';
import { PaymentService, normalizePaymentMethod, paymentMethodFromMetadata } from './internal/payment-service.js';
import {
  type PaymentProvider,
  MockPaymentProvider,
  type ProviderCreateIntentInput,
  type ProviderIntentResult,
  type ProviderCreateAttemptInput,
  type ProviderAttemptResult,
  type ProviderWebhookEvent,
  type ProviderRefundInput,
  type ProviderRefundResult,
} from './internal/payment-provider.js';
import type {
  CreatePaymentIntentInput,
  CreatePaymentAttemptInput,
  CreateRefundInput,
  PaymentIntentDto,
  PaymentAttemptDto,
  PaymentRefundDto,
  WebhookProcessResultDto,
} from './internal/payment-service.js';
import type {
  PaymentIntentStatus,
  PaymentAttemptStatus,
  RefundStatus,
  WebhookProcessStatus,
} from './internal/payment-repository.js';

export type {
  PaymentProvider,
  ProviderCreateIntentInput,
  ProviderIntentResult,
  ProviderCreateAttemptInput,
  ProviderAttemptResult,
  ProviderWebhookEvent,
  ProviderRefundInput,
  ProviderRefundResult,
  CreatePaymentIntentInput,
  CreatePaymentAttemptInput,
  CreateRefundInput,
  PaymentIntentDto,
  PaymentAttemptDto,
  PaymentRefundDto,
  WebhookProcessResultDto,
  PaymentIntentStatus,
  PaymentAttemptStatus,
  RefundStatus,
  WebhookProcessStatus,
};

import type { OutboxService } from '../events/index.js';

export interface PaymentModule {
  readonly contextName: 'payment';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    checkoutService: CheckoutService,
    outboxService: OutboxService,
    provider?: PaymentProvider,
    webhookSecret?: string,
  ): PaymentService;
}

export const paymentModule: PaymentModule = {
  contextName: 'payment',
  createService(
    db: DatabaseConnection,
    logger: Logger,
    checkoutService: CheckoutService,
    outboxService: OutboxService,
    provider?: PaymentProvider,
    webhookSecret?: string,
  ): PaymentService {
    return new PaymentService(db, logger, checkoutService, outboxService, provider, webhookSecret);
  },
};

export { PaymentService, MockPaymentProvider, normalizePaymentMethod, paymentMethodFromMetadata };
