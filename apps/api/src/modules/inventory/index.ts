import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { ListingService } from '../marketplace/index.js';
import { InventoryService } from './internal/inventory-service.js';
import type {
  InventoryItemDto,
  InventoryAvailabilityDto,
  InventoryReservationDto,
  InventoryMovementDto,
  InitializeInventoryInput,
  CreateReservationInput,
} from './internal/inventory-service.js';
import type {
  ReservationStatus,
  MovementType,
} from './internal/inventory-repository.js';

export type {
  InventoryItemDto,
  InventoryAvailabilityDto,
  InventoryReservationDto,
  InventoryMovementDto,
  InitializeInventoryInput,
  CreateReservationInput,
  ReservationStatus,
  MovementType,
};

import type { OutboxService } from '../events/index.js';
import type { InventoryCacheInvalidator } from './internal/inventory-service.js';

export type { InventoryCacheInvalidator };

export interface InventoryModule {
  readonly contextName: 'inventory';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    marketplaceService: ListingService,
    outboxService?: OutboxService,
    cacheInvalidator?: InventoryCacheInvalidator | undefined,
  ): InventoryService;
}

export const inventoryModule: InventoryModule = {
  contextName: 'inventory',
  createService(
    db: DatabaseConnection,
    logger: Logger,
    marketplaceService: ListingService,
    outboxService?: OutboxService,
    cacheInvalidator?: InventoryCacheInvalidator | undefined,
  ): InventoryService {
    return new InventoryService(db, logger, marketplaceService, outboxService, cacheInvalidator);
  },
};

export { InventoryService };
