/**
 * BOUNDED CONTEXT: Payment
 * Ownership: Payment intents, attempts, provider transactions, webhooks, refunds, reconciliation.
 */
export interface PaymentModule {
  readonly contextName: 'payment';
}

export const paymentModule: PaymentModule = {
  contextName: 'payment',
};
