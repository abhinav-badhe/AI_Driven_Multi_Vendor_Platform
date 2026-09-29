/**
 * BOUNDED CONTEXT: Marketplace
 * Ownership: Merchant listings, pricing offers, and seller-specific commercial boundaries.
 */
export interface MarketplaceModule {
  readonly contextName: 'marketplace';
}

export const marketplaceModule: MarketplaceModule = {
  contextName: 'marketplace',
};
