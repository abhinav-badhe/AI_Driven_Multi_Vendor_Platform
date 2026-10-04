/**
 * BOUNDED CONTEXT: Events
 * Ownership: Transactional outbox infrastructure, event envelope standards,
 * transport abstractions, durable consumer idempotency receipts.
 */

import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { SearchService } from '../search/index.js';

import {
  type DomainEvent,
  type EventMetadata,
  type EventType,
  type CreateDomainEventInput,
  EventTypes,
  createDomainEvent,
  isEventVersionSupported,
} from './internal/event-envelope.js';

import {
  type EventTransport,
  type EventHandler,
  InMemoryEventTransport,
} from './internal/event-transport.js';

import {
  type OutboxEventRecord,
  type ConsumerReceiptRecord,
  OutboxRepository,
} from './internal/outbox-repository.js';

import {
  type PublishOptions,
  type PublishResult,
  OutboxService,
} from './internal/outbox-service.js';

import {
  type ConsumerExecutionResult,
  BaseEventConsumer,
} from './internal/event-consumer.js';

import { SearchEventConsumer } from './internal/search-consumer.js';

export type {
  DomainEvent,
  EventMetadata,
  EventType,
  CreateDomainEventInput,
  EventTransport,
  EventHandler,
  OutboxEventRecord,
  ConsumerReceiptRecord,
  PublishOptions,
  PublishResult,
  ConsumerExecutionResult,
};

export {
  EventTypes,
  createDomainEvent,
  isEventVersionSupported,
  InMemoryEventTransport,
  OutboxRepository,
  OutboxService,
  BaseEventConsumer,
  SearchEventConsumer,
};

export interface EventsModule {
  readonly contextName: 'events';
  createOutboxService(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
  ): OutboxService;
  createDefaultTransport(): EventTransport;
  createSearchConsumer(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
    searchService: SearchService,
  ): SearchEventConsumer;
}

export const eventsModule: EventsModule = {
  contextName: 'events',
  createOutboxService(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
  ): OutboxService {
    const outboxRepo = new OutboxRepository();
    return new OutboxService(db, outboxRepo, transport, logger);
  },
  createDefaultTransport(): EventTransport {
    return new InMemoryEventTransport();
  },
  createSearchConsumer(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
    searchService: SearchService,
  ): SearchEventConsumer {
    const outboxRepo = new OutboxRepository();
    const consumer = new SearchEventConsumer(db, outboxRepo, transport, logger, searchService);
    consumer.registerSubscriptions();
    return consumer;
  },
};
