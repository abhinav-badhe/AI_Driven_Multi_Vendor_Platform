/**
 * BOUNDED CONTEXT: Fulfillment
 * Ownership: Shipments, packages, tracking numbers, and delivery state transitions.
 */
export interface FulfillmentModule {
  readonly contextName: 'fulfillment';
}

export const fulfillmentModule: FulfillmentModule = {
  contextName: 'fulfillment',
};
