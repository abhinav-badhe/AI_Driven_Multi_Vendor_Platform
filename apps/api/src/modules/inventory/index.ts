/**
 * BOUNDED CONTEXT: Inventory
 * Ownership: Stock truth, warehouse/location tracking, inventory movements, reservations.
 */
export interface InventoryModule {
  readonly contextName: 'inventory';
}

export const inventoryModule: InventoryModule = {
  contextName: 'inventory',
};
