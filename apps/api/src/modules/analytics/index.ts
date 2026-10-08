/**
 * BOUNDED CONTEXT: Analytics
 * Ownership: Analytical facts, dimensions, aggregated read models, KPI calculations,
 * data-quality quarantine, and administrative projection rebuilds.
 *
 * Invariant: Analytics is derived and read-only with respect to transactional business truth.
 * It MUST NOT act as a source of transactional truth and MUST NOT directly mutate transactional tables.
 */

import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { EventTransport } from '../events/index.js';
import { OutboxRepository } from '../events/index.js';

import {
  type TimeGranularity,
  type AnalyticsOrderFact,
  type AnalyticsPaymentFact,
  type AnalyticsFulfillmentFact,
  type AnalyticsSettlementFact,
  type AnalyticsCatalogFact,
  type AnalyticsDailyMetricRecord,
  type AnalyticsQuarantineRecord,
  type AnalyticsRebuildAuditRecord,
  type AnalyticsQueryParams,
  type CommerceKpiDto,
  type MerchantAnalyticsDto,
  type ProductAnalyticsDto,
  type OperationalKpiDto,
  type RebuildAnalyticsResultDto,
  type TrendingProductSignal,
  type CustomerPurchaseHistorySignal,
  type CoPurchaseSignal,
  type IAnalyticsRecommendationReader,
  type ProductDailyDemandRecord,
  type InventoryVelocitySignal,
  type CustomerActivitySignal,
  type OrderAnomalySignal,
  type IAnalyticsMlFeatureReader,
  type AnalyticsPromotionFact,
  type PromotionAnalyticsDto,
} from './internal/analytics-models.js';

import { AnalyticsRepository, formatMoney } from './internal/analytics-repository.js';
import { AnalyticsService } from './internal/analytics-service.js';
import { AnalyticsEventConsumer } from './internal/analytics-consumer.js';

export type {
  TimeGranularity,
  AnalyticsOrderFact,
  AnalyticsPaymentFact,
  AnalyticsFulfillmentFact,
  AnalyticsSettlementFact,
  AnalyticsCatalogFact,
  AnalyticsPromotionFact,
  PromotionAnalyticsDto,
  AnalyticsDailyMetricRecord,
  AnalyticsQuarantineRecord,
  AnalyticsRebuildAuditRecord,
  AnalyticsQueryParams,
  CommerceKpiDto,
  MerchantAnalyticsDto,
  ProductAnalyticsDto,
  OperationalKpiDto,
  RebuildAnalyticsResultDto,
  TrendingProductSignal,
  CustomerPurchaseHistorySignal,
  CoPurchaseSignal,
  IAnalyticsRecommendationReader,
  ProductDailyDemandRecord,
  InventoryVelocitySignal,
  CustomerActivitySignal,
  OrderAnomalySignal,
  IAnalyticsMlFeatureReader,
};

export { AnalyticsRepository, AnalyticsService, AnalyticsEventConsumer, formatMoney };

export interface AnalyticsModule {
  readonly contextName: 'analytics';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    repo?: AnalyticsRepository,
  ): AnalyticsService;
  createConsumer(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
    service: AnalyticsService,
  ): AnalyticsEventConsumer;
}

export const analyticsModule: AnalyticsModule = {
  contextName: 'analytics',
  createService(
    db: DatabaseConnection,
    logger: Logger,
    repo?: AnalyticsRepository,
  ): AnalyticsService {
    return new AnalyticsService(db, logger, repo ?? new AnalyticsRepository());
  },
  createConsumer(
    db: DatabaseConnection,
    transport: EventTransport,
    logger: Logger,
    service: AnalyticsService,
  ): AnalyticsEventConsumer {
    const consumer = new AnalyticsEventConsumer(
      db,
      new OutboxRepository(),
      transport,
      logger,
      service,
    );
    consumer.registerSubscriptions();
    return consumer;
  },
};
