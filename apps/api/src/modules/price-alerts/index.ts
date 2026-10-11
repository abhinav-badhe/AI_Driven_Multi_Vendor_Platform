import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { INotificationClient } from '../notifications/index.js';
import { PriceAlertService } from './internal/price-alert-service.js';
import {
  PriceAlertSweepRunner,
  type PriceAlertSweepRunnerConfig,
} from './internal/price-alert-runner.js';

export { PriceAlertService, PriceAlertSweepRunner, type PriceAlertSweepRunnerConfig };

export interface PriceAlertsModule {
  readonly contextName: 'price-alerts';
  createService(
    db: DatabaseConnection,
    notifications: INotificationClient,
    logger: Logger,
    frontendUrl: string,
  ): PriceAlertService;
  createSweepRunner(
    service: PriceAlertService,
    logger: Logger,
    config?: PriceAlertSweepRunnerConfig,
  ): PriceAlertSweepRunner;
}

export const priceAlertsModule: PriceAlertsModule = {
  contextName: 'price-alerts',
  createService(
    db: DatabaseConnection,
    notifications: INotificationClient,
    logger: Logger,
    frontendUrl: string,
  ): PriceAlertService {
    return new PriceAlertService(db, notifications, logger, frontendUrl);
  },
  createSweepRunner(
    service: PriceAlertService,
    logger: Logger,
    config?: PriceAlertSweepRunnerConfig,
  ): PriceAlertSweepRunner {
    return new PriceAlertSweepRunner(service, logger, config);
  },
};

