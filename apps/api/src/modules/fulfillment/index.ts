import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { OrderService } from '../orders/index.js';
import type { PaymentService } from '../payment/index.js';
import type { InventoryService } from '../inventory/index.js';
import { FulfillmentService } from './internal/fulfillment-service.js';
import type {
  CreateShipmentInput,
  CreateShipmentItemInput,
  UpdateShipmentTrackingInput,
  CreateReturnInput,
  CreateReturnItemInput,
  UpdateReturnStatusOptions,
  ShipmentDto,
  ShipmentItemDto,
  ReturnDto,
  ReturnItemDto,
} from './internal/fulfillment-service.js';
import type {
  ShipmentStatus,
  ReturnStatus,
} from './internal/fulfillment-repository.js';
import {
  type CarrierProvider,
  MockCarrierProvider,
} from './internal/carrier-provider.js';

export type {
  CreateShipmentInput,
  CreateShipmentItemInput,
  UpdateShipmentTrackingInput,
  CreateReturnInput,
  CreateReturnItemInput,
  UpdateReturnStatusOptions,
  ShipmentDto,
  ShipmentItemDto,
  ReturnDto,
  ReturnItemDto,
  ShipmentStatus,
  ReturnStatus,
  CarrierProvider,
};

export { MockCarrierProvider, FulfillmentService };

export interface FulfillmentModule {
  readonly contextName: 'fulfillment';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    orderService: OrderService,
    paymentService: PaymentService,
    inventoryService: InventoryService,
    carrierProvider?: CarrierProvider,
  ): FulfillmentService;
}

export const fulfillmentModule: FulfillmentModule = {
  contextName: 'fulfillment',
  createService(
    db: DatabaseConnection,
    logger: Logger,
    orderService: OrderService,
    paymentService: PaymentService,
    inventoryService: InventoryService,
    carrierProvider?: CarrierProvider,
  ): FulfillmentService {
    return new FulfillmentService(
      db,
      logger,
      orderService,
      paymentService,
      inventoryService,
      carrierProvider,
    );
  },
};
