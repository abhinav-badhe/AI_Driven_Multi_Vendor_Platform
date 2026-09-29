/**
 * BOUNDED CONTEXT: Catalog
 * Ownership: Canonical Product, Category, Variant/SKU identity and master attributes.
 */
export interface CatalogModule {
  readonly contextName: 'catalog';
}

export const catalogModule: CatalogModule = {
  contextName: 'catalog',
};
