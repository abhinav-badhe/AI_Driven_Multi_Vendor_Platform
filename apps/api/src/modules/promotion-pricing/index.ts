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

export * from './internal/promotion-models.js';
export { PromotionRepository, PromotionService, DiscountCalculator };

export interface PromotionPricingModule {
  readonly contextName: 'promotion-pricing';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    outbox?: OutboxService,
  ): PromotionService;
}

export const promotionPricingModule: PromotionPricingModule = {
  contextName: 'promotion-pricing',
  createService(
    db: DatabaseConnection,
    logger: Logger,
    outbox?: OutboxService,
  ): PromotionService {
    return new PromotionService(db, logger, outbox);
  },
};
