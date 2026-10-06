import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { NotificationService } from '../notifications/index.js';
import { PriceAlertService } from './internal/price-alert-service.js';

export { PriceAlertService };

export interface PriceAlertsModule {
  readonly contextName: 'price-alerts';
  createService(
    db: DatabaseConnection,
    notifications: NotificationService,
    logger: Logger,
    frontendUrl: string,
  ): PriceAlertService;
}

export const priceAlertsModule: PriceAlertsModule = {
  contextName: 'price-alerts',
  createService(
    db: DatabaseConnection,
    notifications: NotificationService,
    logger: Logger,
    frontendUrl: string,
  ): PriceAlertService {
    return new PriceAlertService(db, notifications, logger, frontendUrl);
  },
};
