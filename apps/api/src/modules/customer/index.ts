/**
 * BOUNDED CONTEXT: Customer
 * Ownership: Customer-specific data (delivery addresses, preferences, reviews, consent records).
 */
export interface CustomerModule {
  readonly contextName: 'customer';
}

export const customerModule: CustomerModule = {
  contextName: 'customer',
};
