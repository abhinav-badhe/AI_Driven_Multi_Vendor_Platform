import { randomUUID } from 'node:crypto';
import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import { RbacPolicy } from '../../identity/rbac/policy.js';
import type {
  IOrderService,
  CreateOrderInput,
  CustomerOrderDto,
  SellerOrderDto,
  OrderItemDto,
  CustomerOrderStatus,
  SellerOrderStatus,
} from './order-models.js';
import {
  NotFoundError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';

/**
 * InMemoryOrderStore - Zero-DB in-memory order store.
 * Used for isolated testing, offline resilience, and HTTP client fallback.
 */
export class InMemoryOrderStore implements IOrderService {
  private readonly customerOrders = new Map<string, CustomerOrderDto>();
  private readonly sellerOrders = new Map<string, SellerOrderDto>();
  private readonly idempotencyKeys = new Map<string, string>(); // tenantId:key -> orderId

  async createOrderFromCheckout(
    actor: AuthorizedActor,
    input: CreateOrderInput,
  ): Promise<CustomerOrderDto> {
    RbacPolicy.requirePermission(actor, 'order:create-own');

    if (input.idempotencyKey) {
      const cacheKey = `${actor.tenantId}:${input.idempotencyKey}`;
      const existingId = this.idempotencyKeys.get(cacheKey);
      if (existingId) {
        const existing = this.customerOrders.get(existingId);
        if (existing) return existing;
      }
    }

    const customerOrderId = randomUUID();
    const sellerOrderId = randomUUID();
    const now = new Date().toISOString();

    const item: OrderItemDto = {
      id: randomUUID(),
      sellerOrderId,
      customerOrderId,
      listingId: 'listing-demo-1',
      skuId: 'sku-demo-1',
      productId: 'prod-demo-1',
      merchantTenantId: 'merchant-default',
      productName: 'Sample Product',
      productThumbnailUrl: null,
      skuCode: 'SKU-DEMO-001',
      variantInfo: {},
      quantity: 1,
      unitPriceAmount: 1000,
      lineTotalAmount: 1000,
      currency: 'INR',
      inventoryReservationId: randomUUID(),
      createdAt: now,
    };

    const sellerOrder: SellerOrderDto = {
      id: sellerOrderId,
      customerOrderId,
      sellerTenantId: 'merchant-default',
      status: 'PAID',
      currency: 'INR',
      subtotalAmount: 1000,
      discountAmount: 0,
      shippingAmount: 0,
      taxAmount: 0,
      totalAmount: 1000,
      createdAt: now,
      updatedAt: now,
      items: [item],
    };

    const customerOrder: CustomerOrderDto = {
      id: customerOrderId,
      customerTenantId: actor.tenantId,
      checkoutSessionId: input.checkoutSessionId,
      paymentIntentId: input.paymentIntentId,
      paymentMethod: 'CARD',
      status: 'PAID',
      currency: 'INR',
      subtotalAmount: 1000,
      discountAmount: 0,
      shippingAmount: 0,
      taxAmount: 0,
      totalAmount: 1000,
      idempotencyKey: input.idempotencyKey ?? null,
      couponCode: null,
      appliedPromotions: [],
      shippingAddress: null,
      createdAt: now,
      updatedAt: now,
      sellerOrders: [sellerOrder],
      items: [item],
    };

    this.customerOrders.set(customerOrderId, customerOrder);
    this.sellerOrders.set(sellerOrderId, sellerOrder);

    if (input.idempotencyKey) {
      this.idempotencyKeys.set(`${actor.tenantId}:${input.idempotencyKey}`, customerOrderId);
    }

    return customerOrder;
  }

  async getCustomerOrder(actor: AuthorizedActor, id: string): Promise<CustomerOrderDto> {
    const order = this.customerOrders.get(id);
    if (!order) {
      throw new NotFoundError(`Customer order '${id}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'order:read-own');
      RbacPolicy.requireTenantMatch(actor, order.customerTenantId);
    }

    return order;
  }

  async listCustomerOrders(
    actor: AuthorizedActor,
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<CustomerOrderDto[]> {
    if (actor.role === 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'order:read-any');
      const orders = Array.from(this.customerOrders.values());
      const offset = filter?.offset ?? 0;
      const limit = filter?.limit ?? 50;
      return orders.slice(offset, offset + limit);
    }

    RbacPolicy.requirePermission(actor, 'order:read-own');

    const orders = Array.from(this.customerOrders.values()).filter(
      (o) => o.customerTenantId === actor.tenantId,
    );

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 50;
    return orders.slice(offset, offset + limit);
  }

  async getSellerOrder(actor: AuthorizedActor, id: string): Promise<SellerOrderDto> {
    const sellerOrder = this.sellerOrders.get(id);
    if (!sellerOrder) {
      throw new NotFoundError(`Seller order '${id}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'order:read-seller-own');
      RbacPolicy.requireTenantMatch(actor, sellerOrder.sellerTenantId);
    }

    return sellerOrder;
  }

  async listSellerOrders(
    actor: AuthorizedActor,
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<SellerOrderDto[]> {
    RbacPolicy.requirePermission(actor, 'order:read-seller-own');

    const orders = Array.from(this.sellerOrders.values()).filter(
      (o) => o.sellerTenantId === actor.tenantId,
    );

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 50;
    return orders.slice(offset, offset + limit);
  }

  async updateCustomerOrderStatus(
    actor: AuthorizedActor,
    orderId: string,
    nextStatus: CustomerOrderStatus,
  ): Promise<CustomerOrderDto> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'order:manage-any');
    }

    const current = this.customerOrders.get(orderId);
    if (!current) throw new NotFoundError(`Customer order '${orderId}' not found`);

    const validTransitions: Record<CustomerOrderStatus, CustomerOrderStatus[]> = {
      PENDING_PAYMENT: ['PAID', 'CANCELLED'],
      PAID: ['PROCESSING', 'CANCELLED'],
      PROCESSING: ['COMPLETED', 'CANCELLED'],
      COMPLETED: [],
      CANCELLED: [],
    };

    if (!validTransitions[current.status].includes(nextStatus)) {
      throw new InvalidStateTransitionError(
        `Invalid customer order transition from '${current.status}' to '${nextStatus}'`,
      );
    }

    const updated: CustomerOrderDto = {
      ...current,
      status: nextStatus,
      updatedAt: new Date().toISOString(),
    };
    this.customerOrders.set(orderId, updated);
    return updated;
  }

  async updateSellerOrderStatus(
    actor: AuthorizedActor,
    sellerOrderId: string,
    nextStatus: SellerOrderStatus,
  ): Promise<SellerOrderDto> {
    const current = this.sellerOrders.get(sellerOrderId);
    if (!current) throw new NotFoundError(`Seller order '${sellerOrderId}' not found`);

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'order:read-seller-own');
      RbacPolicy.requireTenantMatch(actor, current.sellerTenantId);
    }

    const validTransitions: Record<SellerOrderStatus, SellerOrderStatus[]> = {
      PENDING_PAYMENT: ['PAID', 'CANCELLED'],
      PAID: ['PROCESSING', 'CANCELLED'],
      PROCESSING: ['COMPLETED', 'CANCELLED'],
      COMPLETED: [],
      CANCELLED: [],
    };

    if (!validTransitions[current.status].includes(nextStatus)) {
      throw new InvalidStateTransitionError(
        `Invalid seller order transition from '${current.status}' to '${nextStatus}'`,
      );
    }

    const updated: SellerOrderDto = {
      ...current,
      status: nextStatus,
      updatedAt: new Date().toISOString(),
    };
    this.sellerOrders.set(sellerOrderId, updated);
    return updated;
  }

  // Test helpers
  seedCustomerOrder(order: CustomerOrderDto): void {
    this.customerOrders.set(order.id, order);
    if (order.idempotencyKey) {
      this.idempotencyKeys.set(`${order.customerTenantId}:${order.idempotencyKey}`, order.id);
    }
    for (const sellerOrder of order.sellerOrders) {
      this.sellerOrders.set(sellerOrder.id, sellerOrder);
    }
  }

  seedSellerOrder(sellerOrder: SellerOrderDto): void {
    this.sellerOrders.set(sellerOrder.id, sellerOrder);
  }

  clear(): void {
    this.customerOrders.clear();
    this.sellerOrders.clear();
    this.idempotencyKeys.clear();
  }
}
