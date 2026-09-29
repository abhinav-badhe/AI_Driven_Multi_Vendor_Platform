/**
 * BOUNDED CONTEXT: Promotion & Pricing
 * Ownership: Offers, discounts, promotional rules, coupons, and pricing snapshots.
 */
export interface PromotionPricingModule {
  readonly contextName: 'promotion-pricing';
}

export const promotionPricingModule: PromotionPricingModule = {
  contextName: 'promotion-pricing',
};
