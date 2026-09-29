/**
 * BOUNDED CONTEXT: Search
 * Ownership: Derived read-only query models, search indexes, faceted search projections.
 *
 * Invariant: Search is a derived system.
 * It MUST NOT act as a transactional source of truth and MUST NOT directly write
 * to transactional domain tables.
 */
export interface SearchModule {
  readonly contextName: 'search';
}

export const searchModule: SearchModule = {
  contextName: 'search',
};
