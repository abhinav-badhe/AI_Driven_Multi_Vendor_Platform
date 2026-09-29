/**
 * BOUNDED CONTEXT: Events
 * Ownership: Event contracts, domain event schema registry, outbox infrastructure boundaries.
 * Invariant: Infrastructure only; does not become a generic dumping ground for business logic.
 */
export interface EventsModule {
  readonly contextName: 'events';
}

export const eventsModule: EventsModule = {
  contextName: 'events',
};
