import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { ListingService, IMarketplaceReader } from '../marketplace/index.js';
import { InventoryService } from './internal/inventory-service.js';
import { InMemoryInventoryStore } from './internal/in-memory-inventory-store.js';
import {
  HttpInventoryClient,
  type HttpInventoryClientOptions,
} from './internal/http-inventory-client.js';
import type {
  InventoryItemDto,
  InventoryAvailabilityDto,
  InventoryReservationDto,
  InventoryMovementDto,
  InitializeInventoryInput,
  CreateReservationInput,
  ReservationStatus,
  MovementType,
  IInventoryReader,
  IInventoryService,
} from './internal/inventory-models.js';

export type {
  InventoryItemDto,
  InventoryAvailabilityDto,
  InventoryReservationDto,
  InventoryMovementDto,
  InitializeInventoryInput,
  CreateReservationInput,
  ReservationStatus,
  MovementType,
  IInventoryReader,
  IInventoryService,
  HttpInventoryClientOptions,
};

import type { OutboxService } from '../events/index.js';
import type { InventoryCacheInvalidator } from './internal/inventory-service.js';

export type { InventoryCacheInvalidator };

export interface InventoryModule {
  readonly contextName: 'inventory';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    marketplaceService: IMarketplaceReader | ListingService,
    outboxService?: OutboxService,
    cacheInvalidator?: InventoryCacheInvalidator | undefined,
  ): InventoryService;
  createInMemoryStore(): InMemoryInventoryStore;
  createHttpClient(
    serviceUrl: string,
    options?: HttpInventoryClientOptions,
  ): HttpInventoryClient;
}

export const inventoryModule: InventoryModule = {
  contextName: 'inventory',
  createService(
    db: DatabaseConnection,
    logger: Logger,
    marketplaceService: IMarketplaceReader | ListingService,
    outboxService?: OutboxService,
    cacheInvalidator?: InventoryCacheInvalidator | undefined,
  ): InventoryService {
    return new InventoryService(db, logger, marketplaceService, outboxService, cacheInvalidator);
  },
  createInMemoryStore(): InMemoryInventoryStore {
    return new InMemoryInventoryStore();
  },
  createHttpClient(
    serviceUrl: string,
    options?: HttpInventoryClientOptions,
  ): HttpInventoryClient {
    return new HttpInventoryClient(serviceUrl, options);
  },
};

export { InventoryService, InMemoryInventoryStore, HttpInventoryClient };
