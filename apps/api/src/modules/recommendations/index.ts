/**
 * BOUNDED CONTEXT: Recommendations
 * Ownership: Candidate generation, deterministic ranking, derived recommendation storage,
 * personalized/similar/trending/frequently-bought-together suggestions, cold-start fallbacks,
 * and event-driven invalidation.
 *
 * Invariant: Recommendations is a derived/read capability, NEVER transactional truth.
 * Price and inventory are derived for display only and revalidated by authoritative commerce domains.
 */

import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { CatalogService, ICatalogReader } from '../catalog/index.js';
import type { ListingService, IMarketplaceReader } from '../marketplace/index.js';
import type { EventTransport } from '../events/index.js';
import { OutboxRepository } from '../events/index.js';

import type {
  RecommendationType,
  RecommendationReasonCode,
  RecommendationCandidate,
  RecommendationContext,
  RankedRecommendation,
  DerivedRecommendationRecord,
  ListingOfferSummary,
  RecommendationItemDto,
  RecommendationResponseDto,
  RebuildRecommendationsResultDto,
  IRecommendationCandidateSource,
  IRecommendationRanker,
  IRecommendationStore,
} from './internal/recommendation-models.js';

import { buildScopeKey, SqlRecommendationStore } from './internal/recommendation-store.js';
import {
  DeterministicRuleBasedRanker,
  DEFAULT_RANKER_WEIGHTS,
  type RankerWeights,
} from './internal/recommendation-ranker.js';
import {
  TrendingCandidateSource,
  SimilarProductCandidateSource,
  FrequentlyBoughtTogetherCandidateSource,
  PersonalizedCandidateSource,
  ColdStartCandidateSource,
} from './internal/candidate-sources.js';
import {
  RecommendationService,
  type RecommendationServiceDependencies,
} from './internal/recommendation-service.js';
import { RecommendationEventConsumer } from './internal/recommendation-consumer.js';

export type {
  RecommendationType,
  RecommendationReasonCode,
  RecommendationCandidate,
  RecommendationContext,
  RankedRecommendation,
  DerivedRecommendationRecord,
  ListingOfferSummary,
  RecommendationItemDto,
  RecommendationResponseDto,
  RebuildRecommendationsResultDto,
  IRecommendationCandidateSource,
  IRecommendationRanker,
  IRecommendationStore,
  RecommendationServiceDependencies,
  RankerWeights,
};

export {
  buildScopeKey,
  SqlRecommendationStore,
  DeterministicRuleBasedRanker,
  DEFAULT_RANKER_WEIGHTS,
  TrendingCandidateSource,
  SimilarProductCandidateSource,
  FrequentlyBoughtTogetherCandidateSource,
  PersonalizedCandidateSource,
  ColdStartCandidateSource,
  RecommendationService,
  RecommendationEventConsumer,
};

import { InMemoryRecommendationStore } from './internal/in-memory-recommendation-store.js';
import {
  HttpRecommendationStoreAdapter,
  type HttpRecommendationStoreOptions,
} from './internal/http-recommendation-store.js';

export {
  InMemoryRecommendationStore,
  HttpRecommendationStoreAdapter,
  type HttpRecommendationStoreOptions,
};

import type { IAnalyticsRecommendationReader } from '../analytics/index.js';

export interface RecommendationsModule {
  readonly contextName: 'recommendations';
  createService(
    db: DatabaseConnection | undefined,
    logger: Logger,
    catalogService: ICatalogReader | CatalogService,
    listingService: IMarketplaceReader | ListingService,
    analyticsReader: IAnalyticsRecommendationReader,
    store?: IRecommendationStore,
    ranker?: IRecommendationRanker,
  ): RecommendationService;
  createConsumer(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
    service: RecommendationService,
  ): RecommendationEventConsumer;
  createInMemoryStore(): InMemoryRecommendationStore;
  createHttpStore(
    serviceUrl: string,
    options?: HttpRecommendationStoreOptions,
  ): HttpRecommendationStoreAdapter;
}

export const recommendationsModule: RecommendationsModule = {
  contextName: 'recommendations',
  createService(
    db: DatabaseConnection | undefined,
    logger: Logger,
    catalogService: ICatalogReader | CatalogService,
    listingService: IMarketplaceReader | ListingService,
    analyticsReader: IAnalyticsRecommendationReader,
    store?: IRecommendationStore,
    ranker?: IRecommendationRanker,
  ): RecommendationService {
    return new RecommendationService({
      logger,
      catalogService,
      listingService,
      analyticsReader,
      store: store ?? (db ? new SqlRecommendationStore(db) : new InMemoryRecommendationStore()),
      ranker,
    });
  },
  createConsumer(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
    service: RecommendationService,
  ): RecommendationEventConsumer {
    const consumer = new RecommendationEventConsumer(
      db,
      new OutboxRepository(),
      transport,
      logger,
      service,
    );
    consumer.registerSubscriptions();
    return consumer;
  },
  createInMemoryStore(): InMemoryRecommendationStore {
    return new InMemoryRecommendationStore();
  },
  createHttpStore(
    serviceUrl: string,
    options?: HttpRecommendationStoreOptions,
  ): HttpRecommendationStoreAdapter {
    return new HttpRecommendationStoreAdapter(serviceUrl, options);
  },
};
