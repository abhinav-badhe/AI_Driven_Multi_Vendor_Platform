/**
 * BOUNDED CONTEXT: Cart & Checkout
 * Ownership: Cart/checkout orchestration.
 * Invariant: Does NOT become source of truth for inventory or payment.
 */
export interface CartCheckoutModule {
  readonly contextName: 'cart-checkout';
}

export const cartCheckoutModule: CartCheckoutModule = {
  contextName: 'cart-checkout',
};
