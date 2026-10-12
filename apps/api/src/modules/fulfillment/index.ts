import type { DatabaseConnection } from '../../infra/database/connection.js';
import type { Logger } from '../../observability/logger.js';
import type { OrderService, IOrderService } from '../orders/index.js';
import type { PaymentService, IPaymentService } from '../payment/index.js';
import type { InventoryService, IInventoryService } from '../inventory/index.js';
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

export { MockCarrierProvider, ShippoCarrierProvider, mapShippoStatus };

import type { IFulfillmentReader, IFulfillmentService } from './internal/fulfillment-models.js';
import { InMemoryFulfillmentStore } from './internal/in-memory-fulfillment-store.js';
import {
  HttpFulfillmentClient,
  type HttpFulfillmentClientOptions,
} from './internal/http-fulfillment-client.js';

export type { IFulfillmentReader, IFulfillmentService, HttpFulfillmentClientOptions };

export {
  FulfillmentService,
  FulfillmentRepository,
  InMemoryFulfillmentStore,
  HttpFulfillmentClient,
};

export interface FulfillmentModule {
  readonly contextName: 'fulfillment';
  createService(
    db: DatabaseConnection,
    logger: Logger,
    orderService: IOrderService | OrderService,
    paymentService: IPaymentService | PaymentService,
    inventoryService: IInventoryService | InventoryService,
    carrierProvider?: CarrierProvider,
    callbackSecret?: string,
    outboxService?: OutboxService,
    webhookToleranceSeconds?: number,
    carrierOperationLeaseTimeoutMs?: number,
  ): FulfillmentService;
  createHttpClient(
    serviceUrl: string,
    options?: HttpFulfillmentClientOptions,
  ): HttpFulfillmentClient;
  createInMemoryStore(): InMemoryFulfillmentStore;
}

export const fulfillmentModule: FulfillmentModule = {
  contextName: 'fulfillment',
  createService(
    db: DatabaseConnection,
    logger: Logger,
    orderService: IOrderService | OrderService,
    paymentService: IPaymentService | PaymentService,
    inventoryService: IInventoryService | InventoryService,
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
  createHttpClient(
    serviceUrl: string,
    options?: HttpFulfillmentClientOptions,
  ): HttpFulfillmentClient {
    return new HttpFulfillmentClient(serviceUrl, options);
  },
  createInMemoryStore(): InMemoryFulfillmentStore {
    return new InMemoryFulfillmentStore();
  },
};
