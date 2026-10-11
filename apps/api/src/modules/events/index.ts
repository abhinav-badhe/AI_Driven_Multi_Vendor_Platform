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
  type ConsumerOptions,
  type ConsumerRetryOptions,
  type ConsumerRetryResult,
  BaseEventConsumer,
  isUniqueConstraintViolation,
} from './internal/event-consumer.js';

import {
  type ConsumerRetryRunnerConfig,
  ConsumerRetryRunner,
} from './internal/consumer-retry-runner.js';

import { SearchEventConsumer } from './internal/search-consumer.js';

import {
  type IOutboxReader,
  type IOutboxService,
  type ListOutboxEventsFilter,
} from './internal/event-models.js';

import { InMemoryOutboxStore } from './internal/in-memory-outbox-store.js';
import {
  HttpEventTransport,
  type HttpEventTransportOptions,
} from './internal/http-event-transport.js';
import {
  HttpOutboxClient,
  type HttpOutboxClientOptions,
} from './internal/http-outbox-client.js';

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
  ConsumerOptions,
  ConsumerRetryOptions,
  ConsumerRetryResult,
  ConsumerRetryRunnerConfig,
  IOutboxReader,
  IOutboxService,
  ListOutboxEventsFilter,
  HttpEventTransportOptions,
  HttpOutboxClientOptions,
};

export {
  EventTypes,
  createDomainEvent,
  isEventVersionSupported,
  isUniqueConstraintViolation,
  InMemoryEventTransport,
  OutboxRepository,
  OutboxService,
  BaseEventConsumer,
  SearchEventConsumer,
  ConsumerRetryRunner,
  InMemoryOutboxStore,
  HttpEventTransport,
  HttpOutboxClient,
};

export interface EventsModule {
  readonly contextName: 'events';
  createOutboxService(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
  ): OutboxService;
  createDefaultTransport(): EventTransport;
  createHttpTransport(
    serviceUrl: string,
    options?: HttpEventTransportOptions,
  ): HttpEventTransport;
  createHttpOutboxClient(
    serviceUrl: string,
    options?: HttpOutboxClientOptions,
  ): HttpOutboxClient;
  createInMemoryOutboxStore(transport?: EventTransport): InMemoryOutboxStore;
  createSearchConsumer(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
    searchService: SearchService,
  ): SearchEventConsumer;
  createConsumerRetryRunner(
    logger: Logger,
    config?: ConsumerRetryRunnerConfig,
  ): ConsumerRetryRunner;
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
  createHttpTransport(
    serviceUrl: string,
    options?: HttpEventTransportOptions,
  ): HttpEventTransport {
    return new HttpEventTransport(serviceUrl, options);
  },
  createHttpOutboxClient(
    serviceUrl: string,
    options?: HttpOutboxClientOptions,
  ): HttpOutboxClient {
    return new HttpOutboxClient(serviceUrl, options);
  },
  createInMemoryOutboxStore(transport?: EventTransport): InMemoryOutboxStore {
    return new InMemoryOutboxStore(transport);
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
  createConsumerRetryRunner(
    logger: Logger,
    config?: ConsumerRetryRunnerConfig,
  ): ConsumerRetryRunner {
    return new ConsumerRetryRunner(logger, config);
  },
};

