/**
 * BOUNDED CONTEXT: Promotion & Pricing
 * Ownership: Offers, discounts, promotional rules, coupons, usage tracking, and pricing snapshots.
 */
import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { OutboxService } from '../events/index.js';
import { PromotionRepository } from './internal/promotion-repository.js';
import { PromotionService } from './internal/promotion-service.js';
import { DiscountCalculator } from './internal/discount-calculator.js';
import { InMemoryPromotionStore } from './internal/in-memory-promotion-store.js';
import {
  HttpPromotionPricingClient,
  type HttpPromotionPricingClientOptions,
} from './internal/http-promotion-client.js';

export * from './internal/promotion-models.js';
export {
  PromotionRepository,
  PromotionService,
  DiscountCalculator,
  InMemoryPromotionStore,
  HttpPromotionPricingClient,
};

import type { ISecurityAuditService } from '../identity/index.js';

export interface PromotionPricingModule {
  readonly contextName: 'promotion-pricing';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    outbox?: OutboxService,
    audit?: ISecurityAuditService,
  ): PromotionService;
  createInMemoryStore(): InMemoryPromotionStore;
  createHttpClient(options: HttpPromotionPricingClientOptions): HttpPromotionPricingClient;
}

export const promotionPricingModule: PromotionPricingModule = {
  contextName: 'promotion-pricing',
  createService(
    db: DatabaseConnection,
    logger: Logger,
    outbox?: OutboxService,
    audit?: ISecurityAuditService,
  ): PromotionService {
    return new PromotionService(db, logger, outbox, audit);
  },
  createInMemoryStore(): InMemoryPromotionStore {
    return new InMemoryPromotionStore();
  },
  createHttpClient(options: HttpPromotionPricingClientOptions): HttpPromotionPricingClient {
    return new HttpPromotionPricingClient(options);
  },
};
