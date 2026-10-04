import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import {
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';
import { RbacPolicy, type AuthorizedActor } from '../../identity/rbac/policy.js';
import type { OrderService } from '../../orders/index.js';
import type { PaymentService } from '../../payment/index.js';
import type { InventoryService } from '../../inventory/index.js';
import {
  FulfillmentRepository,
  type ShipmentRow,
  type ShipmentItemRow,
  type ReturnRow,
  type ReturnItemRow,
  type ShipmentStatus,
  type ReturnStatus,
} from './fulfillment-repository.js';
import {
  type CarrierProvider,
  MockCarrierProvider,
} from './carrier-provider.js';

export interface CreateShipmentItemInput {
  orderItemId: string;
  quantity: number;
}

export interface CreateShipmentInput {
  sellerOrderId: string;
  items: CreateShipmentItemInput[];
  carrier?: string | undefined;
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

export class FulfillmentService {
  private readonly repo: FulfillmentRepository;
  private readonly carrierProvider: CarrierProvider;
  private readonly callbackSecret: string;

  constructor(
    private readonly db: DatabaseConnection,
    private readonly logger: Logger,
    private readonly orderService: OrderService,
    private readonly paymentService: PaymentService,
    private readonly inventoryService: InventoryService,
    carrierProvider?: CarrierProvider,
    callbackSecret = 'whsec_carrier_mock_secret',
  ) {
    this.repo = new FulfillmentRepository(db);
    this.carrierProvider = carrierProvider ?? new MockCarrierProvider();
    this.callbackSecret = callbackSecret;
  }

  private readonly mutexLocks = new Map<string, Promise<void>>();

  private async acquireLock(key: string): Promise<() => void> {
    while (this.mutexLocks.has(key)) {
      try {
        await this.mutexLocks.get(key);
      } catch {
        // ignore errors
      }
    }
    let resolveLock!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    this.mutexLocks.set(key, promise);
    return () => {
      this.mutexLocks.delete(key);
      resolveLock();
    };
  }

  getCarrierProvider(): CarrierProvider {
    return this.carrierProvider;
  }

  getCallbackSecret(): string {
    return this.callbackSecret;
  }

  // --- SHIPMENT OPERATIONS ---

  async createShipment(
    actor: AuthorizedActor,
    input: CreateShipmentInput,
  ): Promise<ShipmentDto> {
    const releaseLock = await this.acquireLock(`ship_${input.sellerOrderId}`);
    try {
      return await this.createShipmentInternal(actor, input);
    } finally {
      releaseLock();
    }
  }

  private async createShipmentInternal(
    actor: AuthorizedActor,
    input: CreateShipmentInput,
  ): Promise<ShipmentDto> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'fulfillment:create-own');
    }

    if (!input.items || input.items.length === 0) {
      throw new ValidationError('Shipment must contain at least one item');
    }

    // 1. Early Idempotency Check with Parameter Fingerprinting
    if (input.idempotencyKey && actor.tenantId) {
      const existing = await this.repo.findShipmentByIdempotency(
        actor.tenantId,
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.seller_order_id !== input.sellerOrderId) {
          throw new ValidationError(
            `Shipment idempotency key '${input.idempotencyKey}' reuse with different seller order.`,
          );
        }
        const existingItems = await this.repo.findShipmentItemsByShipment(existing.id);
        const existingMap = new Map(existingItems.map((i) => [i.order_item_id, i.quantity]));
        const reqMap = new Map(input.items.map((i) => [i.orderItemId, i.quantity]));
        if (existingMap.size !== reqMap.size) {
          throw new ValidationError(
            `Shipment idempotency key '${input.idempotencyKey}' reuse with different item count.`,
          );
        }
        for (const [k, v] of reqMap.entries()) {
          if (existingMap.get(k) !== v) {
            throw new ValidationError(
              `Shipment idempotency key '${input.idempotencyKey}' reuse with different item quantities.`,
            );
          }
        }
        return this.toShipmentDto(existing, existingItems);
      }
    }

    // 2. Fetch Seller Order through authoritative Order Service
    const adminActor: AuthorizedActor = {
      userId: actor.userId,
      tenantId: actor.tenantId,
      role: 'ADMINISTRATOR',
    };
    const sellerOrder = await this.orderService.getSellerOrder(adminActor, input.sellerOrderId);
    if (!sellerOrder) {
      throw new NotFoundError(`Seller order '${input.sellerOrderId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, sellerOrder.sellerTenantId);
    }

    // 3. Validate Seller Order Status
    if (sellerOrder.status !== 'PAID' && sellerOrder.status !== 'PROCESSING') {
      throw new InvalidStateTransitionError(
        `Cannot fulfill seller order in status '${sellerOrder.status}'. Order must be 'PAID' or 'PROCESSING'.`,
      );
    }

    // 4. Validate Items and Quantities
    const orderItemsMap = new Map((sellerOrder.items ?? []).map((it) => [it.id, it]));

    for (const reqItem of input.items) {
      if (!Number.isInteger(reqItem.quantity) || reqItem.quantity <= 0) {
        throw new ValidationError(
          `Shipment item quantity must be a positive integer, got ${reqItem.quantity}`,
        );
      }

      const orderItem = orderItemsMap.get(reqItem.orderItemId);
      if (!orderItem) {
        throw new ValidationError(
          `Order item '${reqItem.orderItemId}' does not belong to seller order '${sellerOrder.id}'`,
        );
      }

      const totalFulfilled = await this.repo.getTotalFulfilledQuantityByOrderItem(
        reqItem.orderItemId,
      );
      const remainingFulfillable = orderItem.quantity - totalFulfilled;

      if (reqItem.quantity > remainingFulfillable) {
        throw new ValidationError(
          `Requested shipment quantity ${reqItem.quantity} for item '${reqItem.orderItemId}' exceeds remaining fulfillable quantity ${remainingFulfillable} (total: ${orderItem.quantity}, fulfilled: ${totalFulfilled})`,
        );
      }
    }

    // 5. Transactional Shipment Creation
    const shipmentId = randomUUID();
    return this.db.withTransaction(async (tx) => {
      // Database row-level lock on seller order to serialize fulfillment across application processes
      await tx.query('SELECT id FROM seller_orders WHERE id = $1 FOR UPDATE', [sellerOrder.id]);

      const txRepo = new FulfillmentRepository(tx);

      // Re-verify under transaction if idempotency key race
      if (input.idempotencyKey) {
        const raceExisting = await txRepo.findShipmentByIdempotency(
          sellerOrder.sellerTenantId,
          input.idempotencyKey,
        );
        if (raceExisting) {
          const items = await txRepo.findShipmentItemsByShipment(raceExisting.id);
          return this.toShipmentDto(raceExisting, items);
        }
      }

      // Re-verify remaining quantities to prevent concurrent over-fulfillment
      for (const reqItem of input.items) {
        const orderItem = orderItemsMap.get(reqItem.orderItemId)!;
        const totalFulfilled = await txRepo.getTotalFulfilledQuantityByOrderItem(
          reqItem.orderItemId,
        );
        const remaining = orderItem.quantity - totalFulfilled;
        if (reqItem.quantity > remaining) {
          throw new ValidationError(
            `Concurrent fulfillment conflict: Requested quantity ${reqItem.quantity} exceeds remaining fulfillable quantity ${remaining}`,
          );
        }
      }

      const shipmentRow = await txRepo.createShipment({
        id: shipmentId,
        sellerOrderId: sellerOrder.id,
        customerOrderId: sellerOrder.customerOrderId,
        sellerTenantId: sellerOrder.sellerTenantId,
        status: 'READY_TO_SHIP',
        carrier: input.carrier,
        trackingNumber: input.trackingNumber,
        trackingUrl: input.trackingUrl,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata,
      });

      const itemRows: ShipmentItemRow[] = [];
      for (const reqItem of input.items) {
        const itemRow = await txRepo.createShipmentItem({
          id: randomUUID(),
          shipmentId,
          orderItemId: reqItem.orderItemId,
          quantity: reqItem.quantity,
        });
        itemRows.push(itemRow);
      }

      // If seller order was PAID, move to PROCESSING
      if (sellerOrder.status === 'PAID') {
        try {
          await this.orderService.updateSellerOrderStatus(
            adminActor,
            sellerOrder.id,
            'PROCESSING',
          );
        } catch {
          // If already updated concurrently, safe to continue
        }
      }

      return this.toShipmentDto(shipmentRow, itemRows);
    });
  }

  async getShipment(actor: AuthorizedActor, id: string): Promise<ShipmentDto> {
    const row = await this.repo.findShipmentById(id);
    if (!row) {
      throw new NotFoundError(`Shipment '${id}' not found`);
    }

    if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'fulfillment:read-own');
      RbacPolicy.requireTenantMatch(actor, row.seller_tenant_id);
    } else if (actor.role === 'CUSTOMER') {
      RbacPolicy.requirePermission(actor, 'fulfillment:read-own');
      const adminActor: AuthorizedActor = { ...actor, role: 'ADMINISTRATOR' };
      const customerOrder = await this.orderService.getCustomerOrder(
        adminActor,
        row.customer_order_id,
      );
      if (customerOrder.customerTenantId !== actor.tenantId) {
        throw new NotFoundError(`Shipment '${id}' not found`);
      }
    }

    const items = await this.repo.findShipmentItemsByShipment(row.id);
    return this.toShipmentDto(row, items);
  }

  async listShipments(
    actor: AuthorizedActor,
    filter?: { sellerOrderId?: string | undefined; customerOrderId?: string | undefined },
  ): Promise<ShipmentDto[]> {
    if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'fulfillment:read-own');
      let rows: ShipmentRow[];
      if (filter?.sellerOrderId) {
        rows = await this.repo.findShipmentsBySellerOrder(filter.sellerOrderId);
        rows = rows.filter((r) => r.seller_tenant_id === actor.tenantId);
      } else {
        rows = await this.repo.findShipmentsBySellerTenant(actor.tenantId);
      }
      return Promise.all(
        rows.map(async (r) => this.toShipmentDto(r, await this.repo.findShipmentItemsByShipment(r.id))),
      );
    }

    if (actor.role === 'CUSTOMER') {
      RbacPolicy.requirePermission(actor, 'fulfillment:read-own');
      if (!filter?.customerOrderId) {
        throw new ValidationError('Customer must provide customerOrderId to list shipments');
      }
      const adminActor: AuthorizedActor = { ...actor, role: 'ADMINISTRATOR' };
      const order = await this.orderService.getCustomerOrder(adminActor, filter.customerOrderId);
      if (order.customerTenantId !== actor.tenantId) {
        return [];
      }
      const rows = await this.repo.findShipmentsByCustomerOrder(filter.customerOrderId);
      return Promise.all(
        rows.map(async (r) => this.toShipmentDto(r, await this.repo.findShipmentItemsByShipment(r.id))),
      );
    }

    if (actor.role === 'ADMINISTRATOR') {
      let rows: ShipmentRow[] = [];
      if (filter?.sellerOrderId) {
        rows = await this.repo.findShipmentsBySellerOrder(filter.sellerOrderId);
      } else if (filter?.customerOrderId) {
        rows = await this.repo.findShipmentsByCustomerOrder(filter.customerOrderId);
      }
      return Promise.all(
        rows.map(async (r) => this.toShipmentDto(r, await this.repo.findShipmentItemsByShipment(r.id))),
      );
    }

    return [];
  }

  async updateShipmentStatus(
    actor: AuthorizedActor,
    shipmentId: string,
    nextStatus: ShipmentStatus,
  ): Promise<ShipmentDto> {
    const current = await this.repo.findShipmentById(shipmentId);
    if (!current) {
      throw new NotFoundError(`Shipment '${shipmentId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'fulfillment:update-own');
      RbacPolicy.requireTenantMatch(actor, current.seller_tenant_id);
    }

    // State machine validation
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

    if (!validTransitions[current.status].includes(nextStatus)) {
      throw new InvalidStateTransitionError(
        `Invalid shipment state transition from '${current.status}' to '${nextStatus}'.`,
      );
    }

    const extra: {
      shippedAt?: Date | undefined;
      deliveredAt?: Date | undefined;
    } = {};

    if (nextStatus === 'SHIPPED') {
      extra.shippedAt = new Date();
    } else if (nextStatus === 'DELIVERED') {
      extra.deliveredAt = new Date();
    }

    const updated = await this.repo.updateShipmentStatus(
      shipmentId,
      current.status,
      nextStatus,
      extra,
    );
    if (!updated) {
      throw new InvalidStateTransitionError('Concurrent modification conflict on shipment status update');
    }

    // If shipment is DELIVERED, evaluate if Seller Order can transition to COMPLETED
    if (nextStatus === 'DELIVERED') {
      await this.evaluateSellerOrderCompletion(current.seller_order_id, actor);
    }

    const items = await this.repo.findShipmentItemsByShipment(updated.id);
    return this.toShipmentDto(updated, items);
  }

  async updateShipmentTracking(
    actor: AuthorizedActor,
    shipmentId: string,
    input: UpdateShipmentTrackingInput,
  ): Promise<ShipmentDto> {
    const current = await this.repo.findShipmentById(shipmentId);
    if (!current) {
      throw new NotFoundError(`Shipment '${shipmentId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'fulfillment:update-own');
      RbacPolicy.requireTenantMatch(actor, current.seller_tenant_id);
    }

    if (!input.carrier || !input.trackingNumber) {
      throw new ValidationError('Carrier and tracking number are required');
    }

    const updated = await this.repo.updateShipmentTracking(
      shipmentId,
      input.carrier,
      input.trackingNumber,
      input.trackingUrl,
    );
    if (!updated) {
      throw new NotFoundError(`Shipment '${shipmentId}' not found`);
    }

    const items = await this.repo.findShipmentItemsByShipment(updated.id);
    return this.toShipmentDto(updated, items);
  }

  async handleCarrierCallback(
    rawBody: string,
    signatureHeader: string,
  ): Promise<{ processed: boolean; deduplicated?: boolean; shipmentId: string; status: ShipmentStatus }> {
    const isValid = this.carrierProvider.verifyCallbackSignature(
      rawBody,
      signatureHeader,
      this.callbackSecret,
    );
    if (!isValid) {
      this.logger.warn('Rejected carrier callback due to invalid signature');
      throw new UnauthorizedError('Invalid carrier callback signature');
    }

    const event = this.carrierProvider.parseTrackingCallback(rawBody);
    const shipment = await this.repo.findShipmentByTracking(event.carrier, event.trackingNumber);
    if (!shipment) {
      throw new NotFoundError(
        `Shipment with carrier '${event.carrier}' and tracking '${event.trackingNumber}' not found`,
      );
    }

    // 1. Durable Deduplication Check on (carrier, provider_event_id)
    const existingEvent = await this.repo.findCarrierWebhookEvent(event.carrier, event.eventId);
    if (existingEvent) {
      return {
        processed: true,
        deduplicated: true,
        shipmentId: shipment.id,
        status: shipment.status,
      };
    }

    // 2. Record Event in carrier_webhook_events
    try {
      await this.repo.recordCarrierWebhookEvent({
        id: randomUUID(),
        carrier: event.carrier,
        providerEventId: event.eventId,
        trackingNumber: event.trackingNumber,
        status: event.status,
        payload: {
          location: event.location,
          timestamp: event.timestamp,
        },
      });
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.message.includes('uq_carrier_webhook_event') ||
          (err as { code?: string }).code === '23505')
      ) {
        return {
          processed: true,
          deduplicated: true,
          shipmentId: shipment.id,
          status: shipment.status,
        };
      }
      throw err;
    }

    const systemActor: AuthorizedActor = {
      userId: 'system_carrier',
      tenantId: shipment.seller_tenant_id,
      role: 'ADMINISTRATOR',
    };

    // If callback status matches or is forward transition, apply it
    let latestStatus = shipment.status;
    if (shipment.status !== event.status) {
      try {
        const updated = await this.updateShipmentStatus(systemActor, shipment.id, event.status);
        latestStatus = updated.status;
      } catch (err) {
        this.logger.warn('Carrier status transition not applicable to current shipment state', {
          shipmentId: shipment.id,
          currentStatus: shipment.status,
          eventStatus: event.status,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { processed: true, shipmentId: shipment.id, status: latestStatus };
  }

  private async evaluateSellerOrderCompletion(
    sellerOrderId: string,
    actor: AuthorizedActor,
  ): Promise<void> {
    try {
      const adminActor: AuthorizedActor = { ...actor, role: 'ADMINISTRATOR' };
      const sellerOrder = await this.orderService.getSellerOrder(adminActor, sellerOrderId);
      if (!sellerOrder || sellerOrder.status === 'COMPLETED') return;

      const shipments = await this.repo.findShipmentsBySellerOrder(sellerOrderId);
      if (shipments.length === 0) return;

      const allDelivered = shipments.every((s) => s.status === 'DELIVERED');
      if (!allDelivered) return;

      // Check if all order item quantities are fully fulfilled
      let fullyFulfilled = true;
      for (const item of sellerOrder.items ?? []) {
        const delivered = await this.repo.getTotalDeliveredQuantityByOrderItem(item.id);
        if (delivered < item.quantity) {
          fullyFulfilled = false;
          break;
        }
      }

      if (fullyFulfilled) {
        await this.orderService.updateSellerOrderStatus(adminActor, sellerOrderId, 'COMPLETED');
      }
    } catch (err) {
      this.logger.warn('Failed to evaluate seller order completion', {
        sellerOrderId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- RETURN OPERATIONS ---

  async createReturnRequest(
    actor: AuthorizedActor,
    input: CreateReturnInput,
  ): Promise<ReturnDto> {
    const releaseLock = await this.acquireLock(`ret_${input.sellerOrderId}`);
    try {
      return await this.createReturnRequestInternal(actor, input);
    } finally {
      releaseLock();
    }
  }

  private async createReturnRequestInternal(
    actor: AuthorizedActor,
    input: CreateReturnInput,
  ): Promise<ReturnDto> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'return:create-own');
    }

    if (!input.items || input.items.length === 0) {
      throw new ValidationError('Return request must contain at least one item');
    }

    if (!input.reason || input.reason.trim().length === 0) {
      throw new ValidationError('Return reason is required');
    }

    // 1. Early Idempotency Check with Fingerprinting
    if (input.idempotencyKey && actor.tenantId) {
      const existing = await this.repo.findReturnByIdempotency(
        actor.tenantId,
        input.idempotencyKey,
      );
      if (existing) {
        if (
          existing.customer_order_id !== input.customerOrderId ||
          existing.seller_order_id !== input.sellerOrderId
        ) {
          throw new ValidationError(
            `Return idempotency key '${input.idempotencyKey}' reuse with different order parameters.`,
          );
        }
        const items = await this.repo.findReturnItemsByReturn(existing.id);
        const existingMap = new Map(items.map((i) => [i.order_item_id, i.quantity]));
        const reqMap = new Map(input.items.map((i) => [i.orderItemId, i.quantity]));
        if (existingMap.size !== reqMap.size) {
          throw new ValidationError(
            `Return idempotency key '${input.idempotencyKey}' reuse with different item count.`,
          );
        }
        for (const [k, v] of reqMap.entries()) {
          if (existingMap.get(k) !== v) {
            throw new ValidationError(
              `Return idempotency key '${input.idempotencyKey}' reuse with different item quantities.`,
            );
          }
        }
        return this.toReturnDto(existing, items);
      }
    }

    const adminActor: AuthorizedActor = {
      userId: actor.userId,
      tenantId: actor.tenantId,
      role: 'ADMINISTRATOR',
    };

    // 2. Authoritative Order Verification
    const customerOrder = await this.orderService.getCustomerOrder(
      adminActor,
      input.customerOrderId,
    );
    if (!customerOrder) {
      throw new NotFoundError(`Customer order '${input.customerOrderId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, customerOrder.customerTenantId);
    }

    const sellerOrder = await this.orderService.getSellerOrder(adminActor, input.sellerOrderId);
    if (!sellerOrder) {
      throw new NotFoundError(`Seller order '${input.sellerOrderId}' not found`);
    }

    if (sellerOrder.customerOrderId !== customerOrder.id) {
      throw new ValidationError(
        `Seller order '${sellerOrder.id}' does not belong to customer order '${customerOrder.id}'`,
      );
    }

    // 3. Validate Return Items & Delivery Facts
    const orderItemsMap = new Map((sellerOrder.items ?? []).map((it) => [it.id, it]));

    for (const reqItem of input.items) {
      if (!Number.isInteger(reqItem.quantity) || reqItem.quantity <= 0) {
        throw new ValidationError(`Return item quantity must be positive, got ${reqItem.quantity}`);
      }

      const orderItem = orderItemsMap.get(reqItem.orderItemId);
      if (!orderItem) {
        throw new ValidationError(
          `Order item '${reqItem.orderItemId}' does not belong to seller order '${sellerOrder.id}'`,
        );
      }

      // Check delivered quantity from actual shipments
      const deliveredQty = await this.repo.getTotalDeliveredQuantityByOrderItem(
        reqItem.orderItemId,
      );
      if (deliveredQty === 0) {
        throw new ValidationError(
          `Cannot return item '${reqItem.orderItemId}' because it has not been delivered.`,
        );
      }

      const returnedQty = await this.repo.getTotalReturnedQuantityByOrderItem(reqItem.orderItemId);
      const eligibleRemaining = deliveredQty - returnedQty;

      if (reqItem.quantity > eligibleRemaining) {
        throw new ValidationError(
          `Requested return quantity ${reqItem.quantity} for item '${reqItem.orderItemId}' exceeds eligible delivered quantity ${eligibleRemaining} (delivered: ${deliveredQty}, already returned/requested: ${returnedQty})`,
        );
      }
    }

    // 4. Transactional Return Creation
    const returnId = randomUUID();
    return this.db.withTransaction(async (tx) => {
      // Database row-level lock on seller order to serialize returns across application processes
      await tx.query('SELECT id FROM seller_orders WHERE id = $1 FOR UPDATE', [sellerOrder.id]);

      const txRepo = new FulfillmentRepository(tx);

      // Race check on idempotency
      if (input.idempotencyKey) {
        const raceExisting = await txRepo.findReturnByIdempotency(
          customerOrder.customerTenantId,
          input.idempotencyKey,
        );
        if (raceExisting) {
          const items = await txRepo.findReturnItemsByReturn(raceExisting.id);
          return this.toReturnDto(raceExisting, items);
        }
      }

      // Concurrency check on eligible remaining return quantities
      for (const reqItem of input.items) {
        const deliveredQty = await txRepo.getTotalDeliveredQuantityByOrderItem(
          reqItem.orderItemId,
        );
        const returnedQty = await txRepo.getTotalReturnedQuantityByOrderItem(reqItem.orderItemId);
        const eligible = deliveredQty - returnedQty;
        if (reqItem.quantity > eligible) {
          throw new ValidationError(
            `Concurrent return conflict: Requested quantity ${reqItem.quantity} exceeds remaining eligible quantity ${eligible}`,
          );
        }
      }

      const returnRow = await txRepo.createReturn({
        id: returnId,
        customerTenantId: customerOrder.customerTenantId,
        customerOrderId: customerOrder.id,
        sellerOrderId: sellerOrder.id,
        sellerTenantId: sellerOrder.sellerTenantId,
        reason: input.reason,
        status: 'REQUESTED',
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata,
      });

      const itemRows: ReturnItemRow[] = [];
      for (const reqItem of input.items) {
        const itemRow = await txRepo.createReturnItem({
          id: randomUUID(),
          returnId,
          orderItemId: reqItem.orderItemId,
          quantity: reqItem.quantity,
          reason: reqItem.reason,
        });
        itemRows.push(itemRow);
      }

      return this.toReturnDto(returnRow, itemRows);
    });
  }

  async getReturn(actor: AuthorizedActor, id: string): Promise<ReturnDto> {
    const row = await this.repo.findReturnById(id);
    if (!row) {
      throw new NotFoundError(`Return '${id}' not found`);
    }

    if (actor.role === 'CUSTOMER') {
      RbacPolicy.requirePermission(actor, 'return:read-own');
      RbacPolicy.requireTenantMatch(actor, row.customer_tenant_id);
    } else if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'return:read-own');
      RbacPolicy.requireTenantMatch(actor, row.seller_tenant_id);
    }

    const items = await this.repo.findReturnItemsByReturn(row.id);
    return this.toReturnDto(row, items);
  }

  async listReturns(
    actor: AuthorizedActor,
    filter?: { customerOrderId?: string | undefined; sellerOrderId?: string | undefined },
  ): Promise<ReturnDto[]> {
    if (actor.role === 'CUSTOMER') {
      RbacPolicy.requirePermission(actor, 'return:read-own');
      const rows = await this.repo.findReturnsByCustomerTenant(actor.tenantId);
      return Promise.all(
        rows.map(async (r) => this.toReturnDto(r, await this.repo.findReturnItemsByReturn(r.id))),
      );
    }

    if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'return:read-own');
      const rows = await this.repo.findReturnsBySellerTenant(actor.tenantId);
      return Promise.all(
        rows.map(async (r) => this.toReturnDto(r, await this.repo.findReturnItemsByReturn(r.id))),
      );
    }

    if (actor.role === 'ADMINISTRATOR') {
      const rows = filter?.customerOrderId
        ? await this.repo.findReturnsByCustomerTenant(filter.customerOrderId)
        : [];
      return Promise.all(
        rows.map(async (r) => this.toReturnDto(r, await this.repo.findReturnItemsByReturn(r.id))),
      );
    }

    return [];
  }

  async updateReturnStatus(
    actor: AuthorizedActor,
    returnId: string,
    nextStatus: ReturnStatus,
    options?: UpdateReturnStatusOptions | undefined,
  ): Promise<ReturnDto> {
    if (nextStatus === 'COMPLETED') {
      const releaseLock = await this.acquireLock(`ret_complete_${returnId}`);
      try {
        return await this.updateReturnStatusInternal(actor, returnId, nextStatus, options);
      } finally {
        releaseLock();
      }
    }
    return this.updateReturnStatusInternal(actor, returnId, nextStatus, options);
  }

  private async updateReturnStatusInternal(
    actor: AuthorizedActor,
    returnId: string,
    nextStatus: ReturnStatus,
    options?: UpdateReturnStatusOptions | undefined,
  ): Promise<ReturnDto> {
    const current = await this.repo.findReturnById(returnId);
    if (!current) {
      throw new NotFoundError(`Return '${returnId}' not found`);
    }

    // Idempotent completion check
    if (current.status === nextStatus) {
      const items = await this.repo.findReturnItemsByReturn(current.id);
      return this.toReturnDto(current, items);
    }

    // Role-specific authorization and transition permissions
    if (actor.role === 'CUSTOMER') {
      RbacPolicy.requirePermission(actor, 'return:cancel-own');
      RbacPolicy.requireTenantMatch(actor, current.customer_tenant_id);

      // Customer may only cancel
      if (nextStatus !== 'CANCELLED') {
        throw new ForbiddenError(`Customer may only cancel their return request`);
      }
      if (current.status !== 'REQUESTED' && current.status !== 'APPROVED') {
        throw new InvalidStateTransitionError(
          `Cannot cancel return in status '${current.status}'. Only 'REQUESTED' or 'APPROVED' returns can be cancelled.`,
        );
      }
    } else if (actor.role === 'MERCHANT') {
      RbacPolicy.requirePermission(actor, 'return:manage-own');
      RbacPolicy.requireTenantMatch(actor, current.seller_tenant_id);
    }

    // State machine definition
    const validTransitions: Record<ReturnStatus, ReturnStatus[]> = {
      REQUESTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
      APPROVED: ['IN_TRANSIT', 'CANCELLED'],
      IN_TRANSIT: ['RECEIVED', 'CANCELLED'],
      RECEIVED: ['COMPLETED', 'REJECTED'],
      COMPLETED: [],
      REJECTED: [],
      CANCELLED: [],
    };

    if (!validTransitions[current.status].includes(nextStatus)) {
      throw new InvalidStateTransitionError(
        `Invalid return state transition from '${current.status}' to '${nextStatus}'.`,
      );
    }

    const extra: {
      approvedAt?: Date | undefined;
      rejectedAt?: Date | undefined;
      receivedAt?: Date | undefined;
      completedAt?: Date | undefined;
      refundId?: string | undefined;
    } = {};

    if (nextStatus === 'APPROVED') extra.approvedAt = new Date();
    else if (nextStatus === 'REJECTED') extra.rejectedAt = new Date();
    else if (nextStatus === 'RECEIVED') extra.receivedAt = new Date();
    else if (nextStatus === 'COMPLETED') extra.completedAt = new Date();

    // HANDOFF: When return is COMPLETED, trigger Payment Refund & Inventory restocking
    if (nextStatus === 'COMPLETED') {
      const returnItems = await this.repo.findReturnItemsByReturn(current.id);
      const adminActor: AuthorizedActor = { ...actor, role: 'ADMINISTRATOR' };
      const customerOrder = await this.orderService.getCustomerOrder(
        adminActor,
        current.customer_order_id,
      );

      // 1. Calculate refund amount from line items
      const orderItemsMap = new Map((customerOrder.items ?? []).map((it) => [it.id, it]));
      let refundAmount = 0;
      for (const item of returnItems) {
        const orderItem = orderItemsMap.get(item.order_item_id);
        if (orderItem) {
          refundAmount += orderItem.unitPriceAmount * item.quantity;
        }
      }

      // 2. Execute Payment Refund via Phase 6 abstraction
      if (refundAmount > 0 && customerOrder.paymentIntentId) {
        const idempotencyKey = current.idempotency_key
          ? `ref_${current.idempotency_key}`
          : `ref_ret_${current.id}`;

        const refundDto = await this.paymentService.createRefund(
          adminActor,
          customerOrder.paymentIntentId,
          {
            amount: refundAmount,
            reason: `Return refund: ${current.reason}`,
            idempotencyKey,
          },
        );
        extra.refundId = refundDto.id;
      }

      // 3. Restock inventory via Phase 4 public interface if requested
      if (options?.restock === true) {
        for (const item of returnItems) {
          const orderItem = orderItemsMap.get(item.order_item_id);
          if (orderItem?.listingId) {
            const invItem = await this.inventoryService.getInventoryByListingId(
              adminActor,
              orderItem.listingId,
            );
            if (invItem) {
              const referenceId = `restock_${current.id}_${item.order_item_id}`;
              if (options.restockCondition === 'DEFECTIVE') {
                await this.inventoryService.adjustNonSellable(
                  adminActor,
                  invItem.id,
                  invItem.nonSellableQuantity + item.quantity,
                  `Restocked defective return ${current.id}`,
                  referenceId,
                );
              } else {
                await this.inventoryService.increaseStock(
                  adminActor,
                  invItem.id,
                  item.quantity,
                  `Restocked return ${current.id}`,
                  referenceId,
                );
              }
            }
          }
        }
      }
    }

    const updated = await this.repo.updateReturnStatus(
      returnId,
      current.status,
      nextStatus,
      extra,
    );
    if (!updated) {
      throw new InvalidStateTransitionError('Concurrent modification conflict on return status update');
    }

    const items = await this.repo.findReturnItemsByReturn(updated.id);
    return this.toReturnDto(updated, items);
  }

  // --- DTO CONVERTERS ---

  private toShipmentDto(row: ShipmentRow, items: ShipmentItemRow[] = []): ShipmentDto {
    return {
      id: row.id,
      sellerOrderId: row.seller_order_id,
      customerOrderId: row.customer_order_id,
      sellerTenantId: row.seller_tenant_id,
      status: row.status,
      carrier: row.carrier,
      trackingNumber: row.tracking_number,
      trackingUrl: row.tracking_url,
      shippedAt: row.shipped_at ? row.shipped_at.toISOString() : null,
      deliveredAt: row.delivered_at ? row.delivered_at.toISOString() : null,
      estimatedDeliveryAt: row.estimated_delivery_at
        ? row.estimated_delivery_at.toISOString()
        : null,
      idempotencyKey: row.idempotency_key,
      metadata: row.metadata,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      items: items.map((it) => ({
        id: it.id,
        shipmentId: it.shipment_id,
        orderItemId: it.order_item_id,
        quantity: it.quantity,
        createdAt: it.created_at.toISOString(),
      })),
    };
  }

  private toReturnDto(row: ReturnRow, items: ReturnItemRow[] = []): ReturnDto {
    return {
      id: row.id,
      customerTenantId: row.customer_tenant_id,
      customerOrderId: row.customer_order_id,
      sellerOrderId: row.seller_order_id,
      sellerTenantId: row.seller_tenant_id,
      status: row.status,
      reason: row.reason,
      requestedAt: row.requested_at.toISOString(),
      approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
      rejectedAt: row.rejected_at ? row.rejected_at.toISOString() : null,
      receivedAt: row.received_at ? row.received_at.toISOString() : null,
      completedAt: row.completed_at ? row.completed_at.toISOString() : null,
      refundId: row.refund_id,
      idempotencyKey: row.idempotency_key,
      metadata: row.metadata,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      items: items.map((it) => ({
        id: it.id,
        returnId: it.return_id,
        orderItemId: it.order_item_id,
        quantity: it.quantity,
        reason: it.reason,
        createdAt: it.created_at.toISOString(),
      })),
    };
  }
}
