/**
 * BOUNDED CONTEXT: Merchant
 * Ownership: Merchant/store onboarding, merchant business profile, merchant settings.
 */
export interface MerchantModule {
  readonly contextName: 'merchant';
}

export const merchantModule: MerchantModule = {
  contextName: 'merchant',
};
