import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { CheckoutService, ICheckoutReader } from '../cart-checkout/index.js';
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
import {
  StripePaymentProvider,
  type StripePaymentConfig,
  toStripeAmount,
  fromStripeAmount,
} from './internal/stripe-payment-provider.js';
import {
  RazorpayPaymentProvider,
  type RazorpayPaymentConfig,
  toRazorpayAmount,
  fromRazorpayAmount,
} from './internal/razorpay-payment-provider.js';
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
import type {
  IPaymentReader,
  IPaymentService,
} from './internal/payment-models.js';
import { InMemoryPaymentStore } from './internal/in-memory-payment-store.js';
import {
  HttpPaymentClient,
  type HttpPaymentClientOptions,
} from './internal/http-payment-client.js';

export type {
  IPaymentReader,
  IPaymentService,
  HttpPaymentClientOptions,
};

export interface PaymentModule {
  readonly contextName: 'payment';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    checkoutService: ICheckoutReader | CheckoutService,
    outboxService: OutboxService,
    provider?: PaymentProvider,
    webhookSecret?: string,
    webhookToleranceSeconds?: number,
  ): PaymentService;
  createHttpClient(
    serviceUrl: string,
    options?: HttpPaymentClientOptions,
  ): HttpPaymentClient;
  createInMemoryStore(): InMemoryPaymentStore;
}

export const paymentModule: PaymentModule = {
  contextName: 'payment',
  createService(
    db: DatabaseConnection,
    logger: Logger,
    checkoutService: ICheckoutReader | CheckoutService,
    outboxService: OutboxService,
    provider?: PaymentProvider,
    webhookSecret?: string,
    webhookToleranceSeconds?: number,
  ): PaymentService {
    return new PaymentService(
      db,
      logger,
      checkoutService,
      outboxService,
      provider,
      webhookSecret,
      webhookToleranceSeconds,
    );
  },
  createHttpClient(
    serviceUrl: string,
    options?: HttpPaymentClientOptions,
  ): HttpPaymentClient {
    return new HttpPaymentClient(serviceUrl, options);
  },
  createInMemoryStore(): InMemoryPaymentStore {
    return new InMemoryPaymentStore();
  },
};

export {
  PaymentService,
  InMemoryPaymentStore,
  HttpPaymentClient,
  MockPaymentProvider,
  StripePaymentProvider,
  type StripePaymentConfig,
  toStripeAmount,
  fromStripeAmount,
  RazorpayPaymentProvider,
  type RazorpayPaymentConfig,
  toRazorpayAmount,
  fromRazorpayAmount,
  normalizePaymentMethod,
  paymentMethodFromMetadata,
};
