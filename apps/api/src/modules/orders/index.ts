/**
 * BOUNDED CONTEXT: Orders
 * Ownership: Customer Order and Seller Order state machines, lifecycle transitions.
 */
export interface OrdersModule {
  readonly contextName: 'orders';
}

export const ordersModule: OrdersModule = {
  contextName: 'orders',
};
