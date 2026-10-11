import { randomUUID } from 'node:crypto';
import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import { RbacPolicy } from '../../identity/rbac/policy.js';
import type {
  IFulfillmentService,
  CreateShipmentInput,
  UpdateShipmentTrackingInput,
  CreateReturnInput,
  UpdateReturnStatusOptions,
  ShipmentDto,
  ShipmentItemDto,
  ReturnDto,
  ReturnItemDto,
  ShipmentStatus,
  ReturnStatus,
  CarrierCallbackResultDto,
} from './fulfillment-models.js';
import type { CarrierTrackingEvent } from './carrier-provider.js';
import {
  ValidationError,
  NotFoundError,
  InvalidStateTransitionError,
  UnauthorizedError,
} from '../../../errors/app-error.js';

/**
 * InMemoryFulfillmentStore - Zero-DB in-memory fulfillment store for standalone testing and fallback.
 */
export class InMemoryFulfillmentStore implements IFulfillmentService {
  private readonly shipments = new Map<string, ShipmentDto>();
  private readonly returns = new Map<string, ReturnDto>();
  private readonly shipmentIdempotency = new Map<string, string>(); // tenantId:key -> shipmentId
  private readonly returnIdempotency = new Map<string, string>(); // tenantId:key -> returnId
  private readonly trackingEvents = new Map<string, CarrierTrackingEvent[]>();

  async createShipment(
    actor: AuthorizedActor,
    input: CreateShipmentInput,
  ): Promise<ShipmentDto> {
    RbacPolicy.requirePermission(actor, 'fulfillment:create-own');

    if (!input.sellerOrderId) {
      throw new ValidationError('sellerOrderId is required');
    }
    if (!input.items || input.items.length === 0) {
      throw new ValidationError('Shipment must contain at least one item');
    }

    if (input.idempotencyKey) {
      const cacheKey = `${actor.tenantId}:${input.idempotencyKey}`;
      const existingId = this.shipmentIdempotency.get(cacheKey);
      if (existingId) {
        const existing = this.shipments.get(existingId);
        if (existing) return existing;
      }
    }

    const shipmentId = randomUUID();
    const now = new Date().toISOString();

    const items: ShipmentItemDto[] = input.items.map((it) => ({
      id: randomUUID(),
      shipmentId,
      orderItemId: it.orderItemId,
      quantity: it.quantity,
      createdAt: now,
    }));

    const shipment: ShipmentDto = {
      id: shipmentId,
      sellerOrderId: input.sellerOrderId,
      customerOrderId: `cust-ord-${input.sellerOrderId.slice(0, 8)}`,
      sellerTenantId: actor.tenantId,
      status: 'READY_TO_SHIP',
      carrier: input.carrier ?? 'MockCarrier',
      trackingNumber: input.trackingNumber ?? `TRK-${randomUUID().slice(0, 8).toUpperCase()}`,
      trackingUrl: input.trackingUrl ?? null,
      carrierShipmentId: `cs_${randomUUID().slice(0, 8)}`,
      labelUrl: 'https://carrier.mock/labels/sample.pdf',
      shippedAt: null,
      deliveredAt: null,
      estimatedDeliveryAt: new Date(Date.now() + 86400000 * 3).toISOString(),
      idempotencyKey: input.idempotencyKey ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
      items,
    };

    this.shipments.set(shipmentId, shipment);
    if (input.idempotencyKey) {
      this.shipmentIdempotency.set(`${actor.tenantId}:${input.idempotencyKey}`, shipmentId);
    }

    return shipment;
  }

  async getShipment(actor: AuthorizedActor, id: string): Promise<ShipmentDto> {
    const shipment = this.shipments.get(id);
    if (!shipment) {
      throw new NotFoundError(`Shipment '${id}' not found`);
    }

    if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'fulfillment:read-own');
      RbacPolicy.requireTenantMatch(actor, shipment.sellerTenantId);
    } else if (actor.role === 'CUSTOMER') {
      RbacPolicy.requirePermission(actor, 'order:read-own');
    }

    return shipment;
  }

  async listShipments(
    actor: AuthorizedActor,
    filter?: { sellerOrderId?: string | undefined; customerOrderId?: string | undefined } | undefined,
  ): Promise<ShipmentDto[]> {
    let list = Array.from(this.shipments.values());

    if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'fulfillment:read-own');
      list = list.filter((s) => s.sellerTenantId === actor.tenantId);
    }

    if (filter?.sellerOrderId) {
      list = list.filter((s) => s.sellerOrderId === filter.sellerOrderId);
    }
    if (filter?.customerOrderId) {
      list = list.filter((s) => s.customerOrderId === filter.customerOrderId);
    }

    return list;
  }

  async updateShipmentStatus(
    actor: AuthorizedActor,
    shipmentId: string,
    nextStatus: ShipmentStatus,
  ): Promise<ShipmentDto> {
    const shipment = this.shipments.get(shipmentId);
    if (!shipment) {
      throw new NotFoundError(`Shipment '${shipmentId}' not found`);
    }

    if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'fulfillment:update-own');
      RbacPolicy.requireTenantMatch(actor, shipment.sellerTenantId);
    }

    const validTransitions: Record<ShipmentStatus, ShipmentStatus[]> = {
      PENDING: ['READY_TO_SHIP', 'CANCELLED'],
      READY_TO_SHIP: ['SHIPPED', 'CANCELLED'],
      SHIPPED: ['IN_TRANSIT', 'FAILED'],
      IN_TRANSIT: ['OUT_FOR_DELIVERY', 'FAILED'],
      OUT_FOR_DELIVERY: ['DELIVERED', 'FAILED'],
      DELIVERED: ['RETURNED'],
      CANCELLED: [],
      FAILED: [],
      RETURNED: [],
    };

    if (!validTransitions[shipment.status].includes(nextStatus)) {
      throw new InvalidStateTransitionError(
        `Invalid shipment status transition from '${shipment.status}' to '${nextStatus}'`,
      );
    }

    const now = new Date().toISOString();
    const updated: ShipmentDto = {
      ...shipment,
      status: nextStatus,
      updatedAt: now,
      shippedAt: nextStatus === 'IN_TRANSIT' ? now : shipment.shippedAt,
      deliveredAt: nextStatus === 'DELIVERED' ? now : shipment.deliveredAt,
    };

    this.shipments.set(shipmentId, updated);
    return updated;
  }

  async updateShipmentTracking(
    actor: AuthorizedActor,
    shipmentId: string,
    input: UpdateShipmentTrackingInput,
  ): Promise<ShipmentDto> {
    const shipment = this.shipments.get(shipmentId);
    if (!shipment) {
      throw new NotFoundError(`Shipment '${shipmentId}' not found`);
    }

    if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'fulfillment:update-own');
      RbacPolicy.requireTenantMatch(actor, shipment.sellerTenantId);
    }

    const updated: ShipmentDto = {
      ...shipment,
      carrier: input.carrier,
      trackingNumber: input.trackingNumber,
      trackingUrl: input.trackingUrl ?? shipment.trackingUrl,
      updatedAt: new Date().toISOString(),
    };

    this.shipments.set(shipmentId, updated);
    return updated;
  }

  async cancelShipment(actor: AuthorizedActor, shipmentId: string): Promise<ShipmentDto> {
    const shipment = this.shipments.get(shipmentId);
    if (!shipment) {
      throw new NotFoundError(`Shipment '${shipmentId}' not found`);
    }

    if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'fulfillment:update-own');
      RbacPolicy.requireTenantMatch(actor, shipment.sellerTenantId);
    }

    if (shipment.status === 'DELIVERED') {
      throw new InvalidStateTransitionError('Cannot cancel a delivered shipment');
    }

    const updated: ShipmentDto = {
      ...shipment,
      status: 'CANCELLED',
      updatedAt: new Date().toISOString(),
    };

    this.shipments.set(shipmentId, updated);
    return updated;
  }

  async getShipmentTracking(
    actor: AuthorizedActor,
    shipmentId: string,
  ): Promise<CarrierTrackingEvent> {
    const shipment = this.shipments.get(shipmentId);
    if (!shipment) {
      throw new NotFoundError(`Shipment '${shipmentId}' not found`);
    }

    if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'fulfillment:read-own');
      RbacPolicy.requireTenantMatch(actor, shipment.sellerTenantId);
    }

    const events = this.trackingEvents.get(shipmentId);
    if (events && events.length > 0 && events[0]) {
      return events[0];
    }

    return {
      eventId: `evt_${shipmentId}`,
      carrier: shipment.carrier ?? 'MockCarrier',
      trackingNumber: shipment.trackingNumber ?? 'TRK-MOCK',
      status: shipment.status,
      location: 'San Francisco, CA',
      timestamp: new Date().toISOString(),
    };
  }

  async createReturnRequest(
    actor: AuthorizedActor,
    input: CreateReturnInput,
  ): Promise<ReturnDto> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'return:create-own');
    }

    if (!input.items || input.items.length === 0) {
      throw new ValidationError('Return request must contain at least one item');
    }

    if (input.idempotencyKey) {
      const cacheKey = `${actor.tenantId}:${input.idempotencyKey}`;
      const existingId = this.returnIdempotency.get(cacheKey);
      if (existingId) {
        const existing = this.returns.get(existingId);
        if (existing) return existing;
      }
    }

    const returnId = randomUUID();
    const now = new Date().toISOString();

    const items: ReturnItemDto[] = input.items.map((it) => ({
      id: randomUUID(),
      returnId,
      orderItemId: it.orderItemId,
      quantity: it.quantity,
      reason: it.reason ?? input.reason,
      createdAt: now,
    }));

    const returnDto: ReturnDto = {
      id: returnId,
      customerTenantId: actor.tenantId,
      customerOrderId: input.customerOrderId,
      sellerOrderId: input.sellerOrderId,
      sellerTenantId: `merch-${input.sellerOrderId.slice(0, 8)}`,
      status: 'REQUESTED',
      reason: input.reason,
      requestedAt: now,
      approvedAt: null,
      rejectedAt: null,
      receivedAt: null,
      completedAt: null,
      refundId: null,
      idempotencyKey: input.idempotencyKey ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
      items,
    };

    this.returns.set(returnId, returnDto);
    if (input.idempotencyKey) {
      this.returnIdempotency.set(`${actor.tenantId}:${input.idempotencyKey}`, returnId);
    }

    return returnDto;
  }

  async getReturn(actor: AuthorizedActor, returnId: string): Promise<ReturnDto> {
    const ret = this.returns.get(returnId);
    if (!ret) {
      throw new NotFoundError(`Return '${returnId}' not found`);
    }

    if (actor.role === 'CUSTOMER') {
      RbacPolicy.requirePermission(actor, 'return:read-own');
      RbacPolicy.requireTenantMatch(actor, ret.customerTenantId);
    } else if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'return:read-own');
      RbacPolicy.requireTenantMatch(actor, ret.sellerTenantId);
    }

    return ret;
  }

  async listReturns(
    actor: AuthorizedActor,
    filter?: { customerOrderId?: string | undefined; sellerOrderId?: string | undefined } | undefined,
  ): Promise<ReturnDto[]> {
    let list = Array.from(this.returns.values());

    if (actor.role === 'CUSTOMER') {
      RbacPolicy.requirePermission(actor, 'return:read-own');
      list = list.filter((r) => r.customerTenantId === actor.tenantId);
    } else if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'return:read-own');
      list = list.filter((r) => r.sellerTenantId === actor.tenantId);
    }

    if (filter?.customerOrderId) {
      list = list.filter((r) => r.customerOrderId === filter.customerOrderId);
    }
    if (filter?.sellerOrderId) {
      list = list.filter((r) => r.sellerOrderId === filter.sellerOrderId);
    }

    return list;
  }

  async updateReturnStatus(
    actor: AuthorizedActor,
    returnId: string,
    nextStatus: ReturnStatus,
    _options?: UpdateReturnStatusOptions | undefined,
  ): Promise<ReturnDto> {
    const ret = this.returns.get(returnId);
    if (!ret) {
      throw new NotFoundError(`Return '${returnId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'fulfillment:update-own');
      RbacPolicy.requireTenantMatch(actor, ret.sellerTenantId);
    }

    const validTransitions: Record<ReturnStatus, ReturnStatus[]> = {
      REQUESTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
      APPROVED: ['IN_TRANSIT', 'RECEIVED', 'CANCELLED'],
      IN_TRANSIT: ['RECEIVED', 'CANCELLED'],
      RECEIVED: ['COMPLETED', 'REJECTED'],
      COMPLETED: [],
      REJECTED: [],
      CANCELLED: [],
    };

    if (!validTransitions[ret.status].includes(nextStatus)) {
      throw new InvalidStateTransitionError(
        `Invalid return state transition from '${ret.status}' to '${nextStatus}'`,
      );
    }

    const now = new Date().toISOString();
    const updated: ReturnDto = {
      ...ret,
      status: nextStatus,
      updatedAt: now,
      approvedAt: nextStatus === 'APPROVED' ? now : ret.approvedAt,
      rejectedAt: nextStatus === 'REJECTED' ? now : ret.rejectedAt,
      receivedAt: nextStatus === 'RECEIVED' ? now : ret.receivedAt,
      completedAt: nextStatus === 'COMPLETED' ? now : ret.completedAt,
      refundId: nextStatus === 'COMPLETED' ? `ref_${returnId.slice(0, 8)}` : ret.refundId,
    };

    this.returns.set(returnId, updated);
    return updated;
  }

  async handleCarrierCallback(
    rawBody: string,
    signatureHeader: string,
  ): Promise<CarrierCallbackResultDto> {
    if (!signatureHeader) {
      throw new UnauthorizedError('Invalid carrier callback signature');
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new ValidationError('Invalid JSON carrier callback payload');
    }

    const shipmentId = String(parsed.shipmentId ?? parsed.id ?? 'ship-default');
    const status = (parsed.status as ShipmentStatus) ?? 'IN_TRANSIT';

    const shipment = this.shipments.get(shipmentId);
    if (shipment) {
      shipment.status = status;
      shipment.updatedAt = new Date().toISOString();
      this.shipments.set(shipmentId, shipment);
    }

    return {
      processed: true,
      deduplicated: false,
      shipmentId,
      status,
    };
  }

  // Testing helpers
  seedShipment(shipment: ShipmentDto): void {
    this.shipments.set(shipment.id, shipment);
    if (shipment.idempotencyKey) {
      this.shipmentIdempotency.set(`${shipment.sellerTenantId}:${shipment.idempotencyKey}`, shipment.id);
    }
  }

  seedReturn(ret: ReturnDto): void {
    this.returns.set(ret.id, ret);
    if (ret.idempotencyKey) {
      this.returnIdempotency.set(`${ret.customerTenantId}:${ret.idempotencyKey}`, ret.id);
    }
  }

  clear(): void {
    this.shipments.clear();
    this.returns.clear();
    this.shipmentIdempotency.clear();
    this.returnIdempotency.clear();
    this.trackingEvents.clear();
  }
}
