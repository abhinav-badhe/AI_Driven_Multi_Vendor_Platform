import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import {
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';
import { RbacPolicy, type AuthorizedActor } from '../../identity/rbac/policy.js';
import type { OrderService, IOrderService, SellerOrderDto, OrderItemDto } from '../../orders/index.js';
import type { PaymentService, IPaymentService } from '../../payment/index.js';
import type { InventoryService, IInventoryService } from '../../inventory/index.js';
import type { OutboxService } from '../../events/index.js';
import { EventTypes, createDomainEvent } from '../../events/index.js';
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
  type CarrierAddress,
  type CarrierTrackingEvent,
  type ProviderShipmentResult,
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

import type { IFulfillmentService } from './fulfillment-models.js';

export class FulfillmentService implements IFulfillmentService {
  private readonly repo: FulfillmentRepository;
  private readonly carrierProvider: CarrierProvider;
  private readonly callbackSecret: string;
  private readonly outboxService?: OutboxService | undefined;
  private readonly webhookToleranceSeconds: number;

  constructor(
    private readonly db: DatabaseConnection,
    private readonly logger: Logger,
    private readonly orderService: IOrderService | OrderService,
    private readonly paymentService: IPaymentService | PaymentService,
    private readonly inventoryService: IInventoryService | InventoryService,
    carrierProvider?: CarrierProvider,
    callbackSecret = 'whsec_carrier_mock_secret',
    outboxService?: OutboxService | undefined,
    webhookToleranceSeconds = 300,
    private readonly carrierOperationLeaseTimeoutMs = 30000,
  ) {
    this.repo = new FulfillmentRepository(db);
    this.carrierProvider = carrierProvider ?? new MockCarrierProvider();
    this.callbackSecret = callbackSecret;
    this.outboxService = outboxService;
    this.webhookToleranceSeconds = webhookToleranceSeconds;
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

    // 5. EXTERNAL CARRIER API CALL (OUTSIDE POSTGRESQL TRANSACTION)
    // Ensures we do NOT hold an active database lock or transaction open during external HTTP calls
    const carrierIdempotencyKey = input.idempotencyKey
      ? `${sellerOrder.sellerTenantId}:${input.idempotencyKey}`
      : `ship_${sellerOrder.id}_${randomUUID()}`;

    const senderAddress: CarrierAddress = input.senderAddress ?? {
      name: `Merchant ${sellerOrder.sellerTenantId}`,
      street1: '123 Merchant Boulevard',
      city: 'San Francisco',
      state: 'CA',
      postalCode: '94105',
      country: 'US',
    };

    let recipientAddress: CarrierAddress;
    if (input.recipientAddress) {
      recipientAddress = input.recipientAddress;
    } else {
      let snapRecipient: CarrierAddress | null = null;
      try {
        const customerOrder = await this.orderService.getCustomerOrder(adminActor, sellerOrder.customerOrderId);
        if (customerOrder.shippingAddress) {
          const snap = customerOrder.shippingAddress;
          snapRecipient = {
            name: snap.recipientName,
            street1: snap.addressLine1,
            street2: snap.addressLine2 ?? undefined,
            city: snap.city,
            state: snap.state,
            postalCode: snap.postalCode,
            country: snap.country,
            phone: snap.phone ?? undefined,
          };
        }
      } catch {
        // Fall back gracefully if order could not be retrieved
      }

      recipientAddress = snapRecipient ?? {
        name: `Customer ${sellerOrder.customerOrderId.slice(0, 8)}`,
        street1: '456 Customer Ave',
        city: 'San Francisco',
        state: 'CA',
        postalCode: '94107',
        country: 'US',
      };
    }

    let carrierResult: ProviderShipmentResult;

    // Check if a carrier shipment was already durably created in PostgreSQL
    const existingOp = await this.repo.findCarrierOperation(carrierIdempotencyKey);

    if (existingOp && existingOp.status === 'COMPLETED' && existingOp.carrier_shipment_id) {
      this.logger.info(
        'Reconciled existing carrier shipment from durable PostgreSQL carrier_shipment_operations',
        {
          idempotencyKey: carrierIdempotencyKey,
          carrierShipmentId: existingOp.carrier_shipment_id,
          trackingNumber: existingOp.tracking_number,
        },
      );
      carrierResult = {
        carrierShipmentId: existingOp.carrier_shipment_id,
        carrier: existingOp.carrier,
        trackingNumber: existingOp.tracking_number || `TRK_${randomUUID().slice(0, 8).toUpperCase()}`,
        trackingUrl: existingOp.tracking_url,
        labelUrl: existingOp.label_url,
        status: 'READY_TO_SHIP',
        estimatedDeliveryAt: null,
        metadata: existingOp.response_payload,
      };
    } else {
      // Coordinate across concurrent requests / multi-instance processes via PostgreSQL
      const claimToken = randomUUID();
      const claimResult = await this.repo.claimCarrierOperation({
        sellerOrderId: sellerOrder.id,
        sellerTenantId: sellerOrder.sellerTenantId,
        carrier: input.carrier || 'shippo',
        idempotencyKey: carrierIdempotencyKey,
        claimToken,
        leaseTimeoutMs: this.carrierOperationLeaseTimeoutMs,
      });

      if (!claimResult.claimed) {
        // Another instance or concurrent request already claimed this operation
        let polledOp = claimResult.operation;
        if (polledOp.status === 'IN_PROGRESS') {
          // Poll up to 25 iterations (2.5 seconds) for the active owner to complete the carrier call
          for (let i = 0; i < 25 && polledOp.status === 'IN_PROGRESS'; i++) {
            await new Promise((r) => setTimeout(r, 100));
            const fresh = await this.repo.findCarrierOperation(carrierIdempotencyKey);
            if (fresh) polledOp = fresh;
          }
        }

        if (polledOp.status === 'COMPLETED' && polledOp.carrier_shipment_id) {
          // Check if the other instance also completed the business transaction in shipments
          if (input.idempotencyKey) {
            const existingShipment = await this.repo.findShipmentByIdempotency(
              sellerOrder.sellerTenantId,
              input.idempotencyKey,
            );
            if (existingShipment) {
              const items = await this.repo.findShipmentItemsByShipment(existingShipment.id);
              return this.toShipmentDto(existingShipment, items);
            }
          }

          carrierResult = {
            carrierShipmentId: polledOp.carrier_shipment_id,
            carrier: polledOp.carrier,
            trackingNumber: polledOp.tracking_number || `TRK_${randomUUID().slice(0, 8).toUpperCase()}`,
            trackingUrl: polledOp.tracking_url,
            labelUrl: polledOp.label_url,
            status: 'READY_TO_SHIP',
            estimatedDeliveryAt: null,
            metadata: polledOp.response_payload,
          };
        } else {
          // Polling finished without completion. The active owner might have crashed or its lease expired.
          // Attempt atomic stale-lease reclamation in PostgreSQL.
          const reclaimToken = randomUUID();
          const reclaimAttempt = await this.repo.claimCarrierOperation({
            sellerOrderId: sellerOrder.id,
            sellerTenantId: sellerOrder.sellerTenantId,
            carrier: input.carrier || 'shippo',
            idempotencyKey: carrierIdempotencyKey,
            claimToken: reclaimToken,
            leaseTimeoutMs: this.carrierOperationLeaseTimeoutMs,
          });

          if (reclaimAttempt.claimed) {
            // Stale lease successfully reclaimed! We now safely own the operation.
            carrierResult = await this.executeCarrierCallAndPersist({
              carrierIdempotencyKey,
              sellerOrder,
              senderAddress,
              recipientAddress,
              orderItemsMap,
              input,
            });
          } else if (
            reclaimAttempt.operation.status === 'COMPLETED' &&
            reclaimAttempt.operation.carrier_shipment_id
          ) {
            // Check if internal shipment already created
            if (input.idempotencyKey) {
              const existingShipment = await this.repo.findShipmentByIdempotency(
                sellerOrder.sellerTenantId,
                input.idempotencyKey,
              );
              if (existingShipment) {
                const items = await this.repo.findShipmentItemsByShipment(existingShipment.id);
                return this.toShipmentDto(existingShipment, items);
              }
            }

            carrierResult = {
              carrierShipmentId: reclaimAttempt.operation.carrier_shipment_id,
              carrier: reclaimAttempt.operation.carrier,
              trackingNumber:
                reclaimAttempt.operation.tracking_number ||
                `TRK_${randomUUID().slice(0, 8).toUpperCase()}`,
              trackingUrl: reclaimAttempt.operation.tracking_url,
              labelUrl: reclaimAttempt.operation.label_url,
              status: 'READY_TO_SHIP',
              estimatedDeliveryAt: null,
              metadata: reclaimAttempt.operation.response_payload,
            };
          } else {
            throw new ConflictError(
              `Concurrent fulfillment in progress for seller order '${sellerOrder.id}'. Please retry shortly.`,
            );
          }
        }
      } else {
        // We claimed the operation. Call external carrier API (OUTSIDE PostgreSQL transaction)
        carrierResult = await this.executeCarrierCallAndPersist({
          carrierIdempotencyKey,
          sellerOrder,
          senderAddress,
          recipientAddress,
          orderItemsMap,
          input,
        });
      }
    }

    // 6. SHORT ATOMIC POSTGRESQL TRANSACTION
    // Atomically persist shipment, items, status update, and outbox event
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

      const effectiveCarrier = carrierResult.carrier || input.carrier || 'MockLogistics';
      const effectiveTracking =
        carrierResult.trackingNumber ||
        input.trackingNumber ||
        `TRK_${randomUUID().slice(0, 8).toUpperCase()}`;
      const effectiveTrackingUrl = carrierResult.trackingUrl || input.trackingUrl || null;
      const effectiveStatus = carrierResult.status || 'READY_TO_SHIP';

      const shipmentRow = await txRepo.createShipment({
        id: shipmentId,
        sellerOrderId: sellerOrder.id,
        customerOrderId: sellerOrder.customerOrderId,
        sellerTenantId: sellerOrder.sellerTenantId,
        status: effectiveStatus,
        carrier: effectiveCarrier,
        trackingNumber: effectiveTracking,
        trackingUrl: effectiveTrackingUrl,
        carrierShipmentId: carrierResult.carrierShipmentId,
        labelUrl: carrierResult.labelUrl,
        idempotencyKey: input.idempotencyKey ?? null,
        metadata: {
          ...(input.metadata ?? {}),
          ...(carrierResult.metadata ?? {}),
          carrierShipmentId: carrierResult.carrierShipmentId,
          labelUrl: carrierResult.labelUrl,
        },
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

      // 7. Atomic Outbox Event in SAME PostgreSQL transaction
      if (this.outboxService) {
        const outboxEvent = createDomainEvent({
          eventType: EventTypes.FULFILLMENT_SHIPMENT_CREATED,
          eventVersion: 1,
          aggregateType: 'shipment',
          aggregateId: shipmentId,
          tenantId: sellerOrder.sellerTenantId,
          payload: {
            shipmentId,
            sellerOrderId: sellerOrder.id,
            customerOrderId: sellerOrder.customerOrderId,
            carrier: effectiveCarrier,
            carrierShipmentId: carrierResult.carrierShipmentId,
            trackingNumber: effectiveTracking,
            status: effectiveStatus,
            items: input.items,
          },
        });
        await this.outboxService.recordEvent(tx, outboxEvent);
      }

      return this.toShipmentDto(shipmentRow, itemRows);
    });
  }

  private async executeCarrierCallAndPersist(params: {
    carrierIdempotencyKey: string;
    sellerOrder: SellerOrderDto;
    senderAddress: CarrierAddress;
    recipientAddress: CarrierAddress;
    orderItemsMap: Map<string, OrderItemDto>;
    input: CreateShipmentInput;
  }): Promise<ProviderShipmentResult> {
    const {
      carrierIdempotencyKey,
      sellerOrder,
      senderAddress,
      recipientAddress,
      orderItemsMap,
      input,
    } = params;

    try {
      const carrierResult = await this.carrierProvider.createShipment({
        sellerOrderId: sellerOrder.id,
        customerOrderId: sellerOrder.customerOrderId,
        senderAddress,
        recipientAddress,
        items: input.items.map((it) => {
          const orderItem = orderItemsMap.get(it.orderItemId);
          return {
            orderItemId: it.orderItemId,
            productTitle: orderItem?.productName,
            quantity: it.quantity,
            unitPrice: orderItem?.unitPriceAmount,
          };
        }),
        carrier: input.carrier,
        trackingNumber: input.trackingNumber,
        serviceLevel: input.serviceLevel,
        idempotencyKey: carrierIdempotencyKey,
        metadata: input.metadata,
      });

      // Durably persist the carrier shipment result into PostgreSQL (independent commit)
      await this.repo.completeCarrierOperation(
        carrierIdempotencyKey,
        {
          carrierShipmentId: carrierResult.carrierShipmentId,
          carrier: carrierResult.carrier,
          trackingNumber: carrierResult.trackingNumber,
          trackingUrl: carrierResult.trackingUrl,
          labelUrl: carrierResult.labelUrl,
          responsePayload: (carrierResult.metadata as Record<string, unknown>) ?? {},
        },
      );

      return carrierResult;
    } catch (carrierErr) {
      await this.repo.failCarrierOperation(carrierIdempotencyKey);
      throw carrierErr;
    }
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

    return this.db.withTransaction(async (tx) => {
      const txRepo = new FulfillmentRepository(tx);
      const updated = await txRepo.updateShipmentStatus(
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
        await this.evaluateSellerOrderCompletionInTx(tx, current.seller_order_id);
      }

      // Record outbox event in tx
      if (this.outboxService) {
        const outboxEvent = createDomainEvent({
          eventType: EventTypes.FULFILLMENT_SHIPMENT_STATUS_CHANGED,
          eventVersion: 1,
          aggregateType: 'shipment',
          aggregateId: shipmentId,
          tenantId: current.seller_tenant_id,
          payload: {
            shipmentId,
            sellerOrderId: current.seller_order_id,
            customerOrderId: current.customer_order_id,
            carrier: current.carrier,
            trackingNumber: current.tracking_number,
            previousStatus: current.status,
            newStatus: nextStatus,
          },
        });
        await this.outboxService.recordEvent(tx, outboxEvent);
      }

      const items = await txRepo.findShipmentItemsByShipment(updated.id);
      return this.toShipmentDto(updated, items);
    });
  }

  async cancelShipment(
    actor: AuthorizedActor,
    shipmentId: string,
    reason?: string,
  ): Promise<ShipmentDto> {
    const current = await this.repo.findShipmentById(shipmentId);
    if (!current) {
      throw new NotFoundError(`Shipment '${shipmentId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'fulfillment:update-own');
      RbacPolicy.requireTenantMatch(actor, current.seller_tenant_id);
    }

    if (current.status !== 'PENDING' && current.status !== 'READY_TO_SHIP') {
      throw new InvalidStateTransitionError(
        `Cannot cancel shipment in status '${current.status}'. Only PENDING or READY_TO_SHIP shipments can be cancelled.`,
      );
    }

    // Call carrier cancellation if carrier shipment id exists
    const carrierShipmentId =
      current.carrier_shipment_id ||
      (current.metadata?.['carrierShipmentId'] as string | undefined);
    if (carrierShipmentId && this.carrierProvider.cancelShipment) {
      try {
        await this.carrierProvider.cancelShipment(carrierShipmentId);
      } catch (err) {
        this.logger.warn('Carrier cancellation call warning', {
          shipmentId,
          carrierShipmentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return this.db.withTransaction(async (tx) => {
      const txRepo = new FulfillmentRepository(tx);
      const updated = await txRepo.updateShipmentStatus(
        shipmentId,
        current.status,
        'CANCELLED',
        {
          metadata: {
            ...current.metadata,
            cancelReason: reason || 'Merchant cancelled',
            cancelledAt: new Date().toISOString(),
          },
        },
      );
      if (!updated) {
        throw new InvalidStateTransitionError('Concurrent modification conflict on shipment cancellation');
      }

      if (this.outboxService) {
        const outboxEvent = createDomainEvent({
          eventType: EventTypes.FULFILLMENT_SHIPMENT_STATUS_CHANGED,
          eventVersion: 1,
          aggregateType: 'shipment',
          aggregateId: shipmentId,
          tenantId: current.seller_tenant_id,
          payload: {
            shipmentId,
            sellerOrderId: current.seller_order_id,
            customerOrderId: current.customer_order_id,
            previousStatus: current.status,
            newStatus: 'CANCELLED',
            reason,
          },
        });
        await this.outboxService.recordEvent(tx, outboxEvent);
      }

      const items = await txRepo.findShipmentItemsByShipment(shipmentId);
      return this.toShipmentDto(updated, items);
    });
  }

  async getShipmentTracking(
    actor: AuthorizedActor,
    shipmentId: string,
  ): Promise<CarrierTrackingEvent> {
    const shipment = await this.getShipment(actor, shipmentId);
    if (!shipment.carrier || !shipment.trackingNumber) {
      return {
        eventId: `trk_${shipmentId}`,
        carrier: shipment.carrier || 'Unknown',
        trackingNumber: shipment.trackingNumber || '',
        status: shipment.status,
        timestamp: new Date().toISOString(),
      };
    }

    return await this.carrierProvider.getTracking(shipment.carrier, shipment.trackingNumber);
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

  // --- CARRIER WEBHOOK TRANSACTION ---

  async handleCarrierCallback(
    rawBody: string,
    signatureHeader: string,
  ): Promise<{ processed: boolean; deduplicated?: boolean; shipmentId: string; status: ShipmentStatus }> {
    // 1. Signature Verification outside transaction (rejects invalid/expired signatures)
    const isValid = this.carrierProvider.verifyCallbackSignature(
      rawBody,
      signatureHeader,
      this.callbackSecret,
      this.webhookToleranceSeconds,
    );
    if (!isValid) {
      this.logger.warn('Rejected carrier callback due to invalid signature or expired timestamp');
      throw new UnauthorizedError('Invalid carrier callback signature');
    }

    const event = this.carrierProvider.parseTrackingCallback(rawBody);

    // 2. Single Atomic PostgreSQL Transaction
    return this.db.withTransaction(async (tx) => {
        const txRepo = new FulfillmentRepository(tx);

        // Lock shipment row to serialize concurrent webhook deliveries
        const shipment = await txRepo.findShipmentByTrackingForUpdate(event.carrier, event.trackingNumber);
        if (!shipment) {
          throw new NotFoundError(
            `Shipment with carrier '${event.carrier}' and tracking '${event.trackingNumber}' not found`,
          );
        }

        // Replay / Duplicate check in carrier_webhook_events
        const existingEvent = await txRepo.findCarrierWebhookEvent(event.carrier, event.eventId);
        if (existingEvent) {
          return {
            processed: true,
            deduplicated: true,
            shipmentId: shipment.id,
            status: shipment.status,
          };
        }

        // Record in carrier_webhook_events ledger
        try {
          await txRepo.recordCarrierWebhookEvent({
            id: randomUUID(),
            carrier: event.carrier,
            providerEventId: event.eventId,
            trackingNumber: event.trackingNumber,
            status: event.status,
            payload: {
              location: event.location,
              timestamp: event.timestamp,
              signature: event.signature,
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

        // State machine validation / Out-of-order protection:
        // Monotonic progression: do not regress terminal or forward states
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

        let latestStatus = shipment.status;
        if (shipment.status !== event.status && validTransitions[shipment.status]?.includes(event.status)) {
          const extra: { shippedAt?: Date; deliveredAt?: Date } = {};
          if (event.status === 'SHIPPED') extra.shippedAt = new Date(event.timestamp);
          else if (event.status === 'DELIVERED') extra.deliveredAt = new Date(event.timestamp);

          const updated = await txRepo.updateShipmentStatus(
            shipment.id,
            shipment.status,
            event.status,
            extra,
          );
          if (updated) {
            latestStatus = updated.status;

            // Record outbox event in same transaction
            if (this.outboxService) {
              const outboxEvt = createDomainEvent({
                eventType: EventTypes.FULFILLMENT_SHIPMENT_STATUS_CHANGED,
                eventVersion: 1,
                aggregateType: 'shipment',
                aggregateId: shipment.id,
                tenantId: shipment.seller_tenant_id,
                payload: {
                  shipmentId: shipment.id,
                  sellerOrderId: shipment.seller_order_id,
                  customerOrderId: shipment.customer_order_id,
                  carrier: shipment.carrier,
                  trackingNumber: shipment.tracking_number,
                  previousStatus: shipment.status,
                  newStatus: event.status,
                  location: event.location,
                  timestamp: event.timestamp,
                },
              });
              await this.outboxService.recordEvent(tx, outboxEvt);
            }

            if (event.status === 'DELIVERED') {
              await this.evaluateSellerOrderCompletionInTx(tx, shipment.seller_order_id);
            }
          }
        }

        return { processed: true, shipmentId: shipment.id, status: latestStatus };
      });
  }

  private async evaluateSellerOrderCompletionInTx(
    tx: DatabaseConnection,
    sellerOrderId: string,
  ): Promise<void> {
    try {
      const txRepo = new FulfillmentRepository(tx);
      const shipments = await txRepo.findShipmentsBySellerOrder(sellerOrderId);
      if (shipments.length === 0) return;

      const allDelivered = shipments.every((s) => s.status === 'DELIVERED');
      if (!allDelivered) return;

      const adminActor: AuthorizedActor = {
        userId: 'system_carrier',
        tenantId: shipments[0]!.seller_tenant_id,
        role: 'ADMINISTRATOR',
      };
      const sellerOrder = await this.orderService.getSellerOrder(adminActor, sellerOrderId);
      if (!sellerOrder || sellerOrder.status === 'COMPLETED') return;

      let fullyFulfilled = true;
      for (const item of sellerOrder.items ?? []) {
        const delivered = await txRepo.getTotalDeliveredQuantityByOrderItem(item.id);
        if (delivered < item.quantity) {
          fullyFulfilled = false;
          break;
        }
      }

      if (fullyFulfilled) {
        await this.orderService.updateSellerOrderStatus(adminActor, sellerOrderId, 'COMPLETED');
      }
    } catch (err) {
      this.logger.warn('Failed to evaluate seller order completion in tx', {
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

      // Outbox event for return request
      if (this.outboxService) {
        const outboxEvt = createDomainEvent({
          eventType: EventTypes.FULFILLMENT_RETURN_STATUS_CHANGED,
          eventVersion: 1,
          aggregateType: 'return',
          aggregateId: returnId,
          tenantId: sellerOrder.sellerTenantId,
          payload: {
            returnId,
            customerOrderId: customerOrder.id,
            sellerOrderId: sellerOrder.id,
            status: 'REQUESTED',
            reason: input.reason,
            items: input.items,
          },
        });
        await this.outboxService.recordEvent(tx, outboxEvt);
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
      metadata?: Record<string, unknown> | undefined;
    } = {};

    if (nextStatus === 'APPROVED') extra.approvedAt = new Date();
    else if (nextStatus === 'REJECTED') extra.rejectedAt = new Date();
    else if (nextStatus === 'RECEIVED') extra.receivedAt = new Date();
    else if (nextStatus === 'COMPLETED') extra.completedAt = new Date();

    // If return is APPROVED, call carrier for return shipment label if supported
    if (nextStatus === 'APPROVED' && this.carrierProvider.createReturnShipment) {
      try {
        const returnItems = await this.repo.findReturnItemsByReturn(current.id);
        const returnShipmentResult = await this.carrierProvider.createReturnShipment({
          returnId: current.id,
          sellerOrderId: current.seller_order_id,
          customerOrderId: current.customer_order_id,
          senderAddress: {
            name: `Customer ${current.customer_tenant_id.slice(0, 8)}`,
            street1: '456 Customer Ave',
            city: 'San Francisco',
            state: 'CA',
            postalCode: '94107',
            country: 'US',
          },
          recipientAddress: {
            name: `Merchant ${current.seller_tenant_id}`,
            street1: '123 Merchant Boulevard',
            city: 'San Francisco',
            state: 'CA',
            postalCode: '94105',
            country: 'US',
          },
          items: returnItems.map((ri) => ({
            orderItemId: ri.order_item_id,
            quantity: ri.quantity,
          })),
          idempotencyKey: `ret_ship_${current.id}`,
        });

        extra.metadata = {
          ...(current.metadata ?? {}),
          returnCarrier: returnShipmentResult.carrier,
          returnTrackingNumber: returnShipmentResult.trackingNumber,
          returnLabelUrl: returnShipmentResult.labelUrl,
          returnShipmentId: returnShipmentResult.carrierShipmentId,
        };
      } catch (err) {
        this.logger.warn('Could not generate carrier return shipment label', {
          returnId: current.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

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

    return this.db.withTransaction(async (tx) => {
      const txRepo = new FulfillmentRepository(tx);
      const updated = await txRepo.updateReturnStatus(
        returnId,
        current.status,
        nextStatus,
        extra,
      );
      if (!updated) {
        throw new InvalidStateTransitionError('Concurrent modification conflict on return status update');
      }

      // Outbox event in same transaction
      if (this.outboxService) {
        const outboxEvt = createDomainEvent({
          eventType: EventTypes.FULFILLMENT_RETURN_STATUS_CHANGED,
          eventVersion: 1,
          aggregateType: 'return',
          aggregateId: returnId,
          tenantId: current.seller_tenant_id,
          payload: {
            returnId,
            customerOrderId: current.customer_order_id,
            sellerOrderId: current.seller_order_id,
            previousStatus: current.status,
            newStatus: nextStatus,
            refundId: extra.refundId ?? null,
          },
        });
        await this.outboxService.recordEvent(tx, outboxEvt);
      }

      const items = await txRepo.findReturnItemsByReturn(updated.id);
      return this.toReturnDto(updated, items);
    });
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
      carrierShipmentId:
        row.carrier_shipment_id ??
        (row.metadata?.['carrierShipmentId'] as string | undefined) ??
        null,
      labelUrl:
        row.label_url ??
        (row.metadata?.['labelUrl'] as string | undefined) ??
        null,
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
