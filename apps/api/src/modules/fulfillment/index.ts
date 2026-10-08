import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { OrderService } from '../orders/index.js';
import type { PaymentService } from '../payment/index.js';
import type { InventoryService } from '../inventory/index.js';
import type { OutboxService } from '../events/index.js';
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
import {
  FulfillmentRepository,
  type ShipmentStatus,
  type ReturnStatus,
} from './internal/fulfillment-repository.js';
import {
  type CarrierProvider,
  type CarrierAddress,
  type CarrierParcel,
  type ProviderCreateShipmentInput,
  type ProviderShipmentResult,
  type ProviderCancelResult,
  type ProviderCreateReturnInput,
  type CarrierTrackingEvent,
  MockCarrierProvider,
} from './internal/carrier-provider.js';
import {
  ShippoCarrierProvider,
  mapShippoStatus,
  type ShippoCarrierConfig,
} from './internal/shippo-carrier-provider.js';

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
  CarrierAddress,
  CarrierParcel,
  ProviderCreateShipmentInput,
  ProviderShipmentResult,
  ProviderCancelResult,
  ProviderCreateReturnInput,
  CarrierTrackingEvent,
  ShippoCarrierConfig,
};

export {
  MockCarrierProvider,
  ShippoCarrierProvider,
  mapShippoStatus,
  FulfillmentService,
  FulfillmentRepository,
};

export interface FulfillmentModule {
  readonly contextName: 'fulfillment';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    orderService: OrderService,
    paymentService: PaymentService,
    inventoryService: InventoryService,
    carrierProvider?: CarrierProvider,
    callbackSecret?: string,
    outboxService?: OutboxService,
    webhookToleranceSeconds?: number,
    carrierOperationLeaseTimeoutMs?: number,
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
    callbackSecret = 'whsec_carrier_mock_secret',
    outboxService?: OutboxService,
    webhookToleranceSeconds = 300,
    carrierOperationLeaseTimeoutMs = 30000,
  ): FulfillmentService {
    return new FulfillmentService(
      db,
      logger,
      orderService,
      paymentService,
      inventoryService,
      carrierProvider,
      callbackSecret,
      outboxService,
      webhookToleranceSeconds,
      carrierOperationLeaseTimeoutMs,
    );
  },
};
