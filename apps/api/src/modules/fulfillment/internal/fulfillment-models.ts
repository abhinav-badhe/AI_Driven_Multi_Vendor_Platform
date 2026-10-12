import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type { ShipmentStatus, ReturnStatus } from './fulfillment-repository.js';
import type { CarrierTrackingEvent, CarrierAddress } from './carrier-provider.js';

export type { ShipmentStatus, ReturnStatus };

export interface CreateShipmentItemInput {
  orderItemId: string;
  quantity: number;
}

export interface CreateShipmentInput {
  sellerOrderId: string;
  items: CreateShipmentItemInput[];
  carrier?: string | undefined;
  serviceLevel?: string | undefined;
  senderAddress?: CarrierAddress | undefined;
  recipientAddress?: CarrierAddress | undefined;
  trackingNumber?: string | undefined;
  trackingUrl?: string | undefined;
  idempotencyKey?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface UpdateShipmentTrackingInput {
  carrier: string;
  trackingNumber: string;
  trackingUrl?: string | undefined;
}

export interface CreateReturnItemInput {
  orderItemId: string;
  quantity: number;
  reason?: string | undefined;
}

export interface CreateReturnInput {
  customerOrderId: string;
  sellerOrderId: string;
  reason: string;
  items: CreateReturnItemInput[];
  idempotencyKey?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface UpdateReturnStatusOptions {
  restock?: boolean | undefined;
  restockCondition?: 'SELLABLE' | 'DEFECTIVE' | undefined;
}

export interface ShipmentItemDto {
  id: string;
  shipmentId: string;
  orderItemId: string;
  quantity: number;
  createdAt: string;
}

export interface ShipmentDto {
  id: string;
  sellerOrderId: string;
  customerOrderId: string;
  sellerTenantId: string;
  status: ShipmentStatus;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrierShipmentId?: string | null | undefined;
  labelUrl?: string | null | undefined;
  shippedAt: string | null;
  deliveredAt: string | null;
  estimatedDeliveryAt: string | null;
  idempotencyKey: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  items?: ShipmentItemDto[] | undefined;
}

export interface ReturnItemDto {
  id: string;
  returnId: string;
  orderItemId: string;
  quantity: number;
  reason: string | null;
  createdAt: string;
}

export interface ReturnDto {
  id: string;
  customerTenantId: string;
  customerOrderId: string;
  sellerOrderId: string;
  sellerTenantId: string;
  status: ReturnStatus;
  reason: string;
  requestedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  receivedAt: string | null;
  completedAt: string | null;
  refundId: string | null;
  idempotencyKey: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  items?: ReturnItemDto[] | undefined;
}

export interface CarrierCallbackResultDto {
  processed: boolean;
  deduplicated?: boolean | undefined;
  shipmentId: string;
  status: ShipmentStatus;
}

/**
 * IFulfillmentReader - Decoupled read interface for downstream consumers.
 */
export interface IFulfillmentReader {
  getShipment(actor: AuthorizedActor, id: string): Promise<ShipmentDto>;
  listShipments(
    actor: AuthorizedActor,
    filter?:
      { sellerOrderId?: string | undefined; customerOrderId?: string | undefined } | undefined,
  ): Promise<ShipmentDto[]>;
  getShipmentTracking(actor: AuthorizedActor, shipmentId: string): Promise<CarrierTrackingEvent>;
  getReturn(actor: AuthorizedActor, returnId: string): Promise<ReturnDto>;
  listReturns(
    actor: AuthorizedActor,
    filter?:
      { customerOrderId?: string | undefined; sellerOrderId?: string | undefined } | undefined,
  ): Promise<ReturnDto[]>;
}

/**
 * IFulfillmentService - Full fulfillment lifecycle orchestration interface.
 * Implemented by FulfillmentService (SQL), InMemoryFulfillmentStore, and HttpFulfillmentClient.
 */
export interface IFulfillmentService extends IFulfillmentReader {
  createShipment(actor: AuthorizedActor, input: CreateShipmentInput): Promise<ShipmentDto>;

  updateShipmentStatus(
    actor: AuthorizedActor,
    shipmentId: string,
    nextStatus: ShipmentStatus,
  ): Promise<ShipmentDto>;

  updateShipmentTracking(
    actor: AuthorizedActor,
    shipmentId: string,
    input: UpdateShipmentTrackingInput,
  ): Promise<ShipmentDto>;

  cancelShipment(actor: AuthorizedActor, shipmentId: string): Promise<ShipmentDto>;

  createReturnRequest(actor: AuthorizedActor, input: CreateReturnInput): Promise<ReturnDto>;

  updateReturnStatus(
    actor: AuthorizedActor,
    returnId: string,
    nextStatus: ReturnStatus,
    options?: UpdateReturnStatusOptions | undefined,
  ): Promise<ReturnDto>;

  handleCarrierCallback(
    rawBody: string,
    signatureHeader: string,
  ): Promise<CarrierCallbackResultDto>;
}
