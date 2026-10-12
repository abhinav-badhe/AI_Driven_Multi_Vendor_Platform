import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import {
  NotFoundError,
  ValidationError,
  InvalidStateTransitionError,
} from '../../../errors/app-error.js';
import { RbacPolicy, type AuthorizedActor } from '../../identity/rbac/policy.js';
import type { CheckoutService, ICheckoutReader } from '../../cart-checkout/index.js';
import type { CatalogService, ICatalogReader } from '../../catalog/index.js';
import type { InventoryService, IInventoryService } from '../../inventory/index.js';
import type { PaymentService, IPaymentReader } from '../../payment/index.js';
import { paymentMethodFromMetadata } from '../../payment/index.js';
import type { OutboxService } from '../../events/index.js';
import { EventTypes, createDomainEvent } from '../../events/index.js';
import {
  OrderRepository,
  type CustomerOrderRow,
  type SellerOrderRow,
  type OrderItemRow,
  type CustomerOrderStatus,
  type SellerOrderStatus,
} from './order-repository.js';

export interface CreateOrderInput {
  checkoutSessionId: string;
  paymentIntentId: string;
  idempotencyKey?: string | null | undefined;
}

export interface OrderItemDto {
  id: string;
  sellerOrderId: string;
  customerOrderId: string;
  listingId: string;
  skuId: string;
  productId: string;
  merchantTenantId: string;
  productName: string;
  productThumbnailUrl?: string | null;
  skuCode: string;
  variantInfo: Record<string, unknown>;
  quantity: number;
  unitPriceAmount: number;
  lineTotalAmount: number;
  currency: string;
  inventoryReservationId: string | null;
  createdAt: string;
}

import type { PromotionService } from '../../promotion-pricing/index.js';
import type { AddressSnapshot } from '../../customer/index.js';

export interface SellerOrderDto {
  id: string;
  customerOrderId: string;
  sellerTenantId: string;
  status: SellerOrderStatus;
  currency: string;
  subtotalAmount: number;
  discountAmount?: number;
  shippingAmount: number;
  taxAmount: number;
  totalAmount: number;
  shippingAddress?: AddressSnapshot | null | undefined;
  createdAt: string;
  updatedAt: string;
  items?: OrderItemDto[] | undefined;
}

export interface CustomerOrderDto {
  id: string;
  customerTenantId: string;
  checkoutSessionId: string;
  paymentIntentId: string | null;
  paymentMethod?: 'COD' | 'UPI' | 'CARD' | null;
  status: CustomerOrderStatus;
  currency: string;
  subtotalAmount: number;
  discountAmount: number;
  shippingAmount: number;
  taxAmount: number;
  totalAmount: number;
  idempotencyKey: string | null;
  couponCode?: string | null;
  appliedPromotions?: unknown[];
  shippingAddress?: AddressSnapshot | null;
  createdAt: string;
  updatedAt: string;
  sellerOrders: SellerOrderDto[];
  items?: OrderItemDto[] | undefined;
}

import type { IOrderService } from './order-models.js';

export class OrderService implements IOrderService {
  private readonly repo: OrderRepository;
  private readonly db: DatabaseConnection;

  constructor(
    db: DatabaseConnection,
    private readonly logger: Logger,
    private readonly checkoutService: ICheckoutReader | CheckoutService,
    private readonly catalogService: ICatalogReader | CatalogService,
    private readonly inventoryService: IInventoryService | InventoryService,
    private readonly paymentService: IPaymentReader | PaymentService,
    private readonly outboxService?: OutboxService | undefined,
    private readonly promotionService?: PromotionService | undefined,
  ) {
    this.repo = new OrderRepository(db);
    this.db = db;
  }

  private async consumeReservations(
    actor: AuthorizedActor,
    customerOrderId: string,
    items: Array<{ inventoryReservationId?: string | null; merchantTenantId: string }>,
  ) {
    for (const item of items) {
      if (item.inventoryReservationId) {
        try {
          const systemActor: AuthorizedActor = {
            userId: actor.userId,
            tenantId: item.merchantTenantId,
            role: 'ADMINISTRATOR',
          };
          await this.inventoryService.consumeReservation(
            systemActor,
            item.inventoryReservationId,
            `Consumed by order ${customerOrderId}`,
          );
        } catch (consumeErr) {
          this.logger.error('Failed to consume inventory reservation for order item', {
            customerOrderId,
            reservationId: item.inventoryReservationId,
            error: consumeErr instanceof Error ? consumeErr.message : String(consumeErr),
          });
          throw consumeErr;
        }
      }
    }
  }

  async createOrderFromCheckout(
    actor: AuthorizedActor,
    input: CreateOrderInput,
  ): Promise<CustomerOrderDto> {
    RbacPolicy.requirePermission(actor, 'order:create-own');

    // 1. Authoritative Checkout Verification
    const checkout = await this.checkoutService.getCheckoutSession(actor, input.checkoutSessionId);
    if (!checkout) {
      throw new NotFoundError(`Checkout session '${input.checkoutSessionId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, checkout.customerTenantId);
    }

    if (checkout.status !== 'READY' && checkout.status !== 'RESERVED') {
      throw new InvalidStateTransitionError(
        `Cannot create order: checkout session '${checkout.id}' is in status '${checkout.status}'. Only READY checkouts can be converted to orders.`,
      );
    }

    if (checkout.items.length === 0) {
      throw new ValidationError('Checkout session has no items');
    }

    // 2. Authoritative Payment Verification
    const payment = await this.paymentService.getPaymentIntent(actor, input.paymentIntentId);
    if (!payment) {
      throw new NotFoundError(`Payment intent '${input.paymentIntentId}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requireTenantMatch(actor, payment.customerTenantId);
    }

    if (payment.status !== 'SUCCEEDED') {
      throw new InvalidStateTransitionError(
        `Cannot finalize order: Payment intent '${payment.id}' has not succeeded (current status: '${payment.status}')`,
      );
    }

    if (payment.checkoutSessionId !== checkout.id) {
      throw new ValidationError(
        `Payment intent '${payment.id}' was created for checkout '${payment.checkoutSessionId}', not '${checkout.id}'`,
      );
    }

    if (payment.amount !== checkout.totalAmount || payment.currency !== checkout.currency) {
      throw new ValidationError(
        `Payment amount/currency (${payment.amount} ${payment.currency}) does not match checkout total (${checkout.totalAmount} ${checkout.currency})`,
      );
    }

    // 3. Idempotency & Crash Recovery Check:
    // Check if an order already exists for this exact checkout session
    const existingByCheckout = await this.repo.findCustomerOrderByCheckoutSession(checkout.id);
    if (existingByCheckout) {
      await this.consumeReservations(actor, existingByCheckout.id, checkout.items);
      return this.assembleFullOrderDto(existingByCheckout);
    }

    if (input.idempotencyKey) {
      const existingByKey = await this.repo.findCustomerOrderByIdempotency(
        actor.tenantId,
        input.idempotencyKey,
      );
      if (existingByKey) {
        if (
          existingByKey.checkout_session_id !== checkout.id ||
          existingByKey.payment_intent_id !== payment.id
        ) {
          throw new ValidationError(
            `Order idempotency key '${input.idempotencyKey}' reuse with different checkout or payment intent`,
          );
        }
        await this.consumeReservations(actor, existingByKey.id, checkout.items);
        return this.assembleFullOrderDto(existingByKey);
      }
    }

    // 4. Fetch catalog historical snapshots for all items before transactional insert
    const itemSnapshots: Array<{
      item: (typeof checkout.items)[0];
      productName: string;
      skuCode: string;
      variantInfo: Record<string, unknown>;
      productId: string;
    }> = [];

    for (const item of checkout.items) {
      const sku = await this.catalogService.getSkuById(item.skuId);
      const product = await this.catalogService.getProductById(sku.productId);

      itemSnapshots.push({
        item,
        productName: product.title,
        skuCode: sku.skuCode,
        variantInfo: sku.attributes,
        productId: product.id,
      });
    }

    // 5. Atomic Order Creation
    let customerOrderRow: CustomerOrderRow;
    let createdSellerOrders: SellerOrderRow[];
    let createdOrderItems: OrderItemRow[];

    try {
      const result = await this.db.withTransaction(async (tx) => {
        const txRepo = new OrderRepository(tx);
        const customerOrderIdInner = randomUUID();
        const createdSellerOrdersInner: SellerOrderRow[] = [];
        const createdOrderItemsInner: OrderItemRow[] = [];

        const customerOrderRowInner = await txRepo.createCustomerOrder({
          id: customerOrderIdInner,
          customerTenantId: actor.tenantId,
          checkoutSessionId: checkout.id,
          paymentIntentId: payment.id,
          status: 'PAID',
          currency: checkout.currency,
          subtotalAmount: checkout.subtotalAmount,
          discountAmount: checkout.discountAmount,
          shippingAmount: checkout.shippingAmount,
          taxAmount: checkout.taxAmount,
          totalAmount: checkout.totalAmount,
          idempotencyKey: input.idempotencyKey ?? null,
          couponCode: checkout.couponCode ?? null,
          appliedPromotions: checkout.appliedPromotions ?? [],
          shippingAddress: checkout.shippingAddress ?? null,
        });

        const itemsByMerchant = new Map<string, Array<(typeof itemSnapshots)[0]>>();
        for (const snap of itemSnapshots) {
          const mId = snap.item.merchantTenantId;
          const group = itemsByMerchant.get(mId) ?? [];
          group.push(snap);
          itemsByMerchant.set(mId, group);
        }

        for (const [merchantTenantId, snaps] of itemsByMerchant.entries()) {
          const sellerOrderId = randomUUID();
          const sellerSubtotal = snaps.reduce((sum, s) => sum + s.item.lineTotalAmount, 0);
          const sellerShipping = 0;
          const sellerTax = 0;

          // Attribute discount from applied promotions
          let merchantDiscount = 0;
          if (Array.isArray(checkout.appliedPromotions)) {
            for (const ap of checkout.appliedPromotions as Array<{
              merchantTenantId?: string | null;
              discountAmount?: number;
            }>) {
              if (ap.merchantTenantId === merchantTenantId) {
                merchantDiscount += ap.discountAmount ?? 0;
              } else if (!ap.merchantTenantId && checkout.subtotalAmount > 0) {
                merchantDiscount += Math.round(
                  ((ap.discountAmount ?? 0) * sellerSubtotal) / checkout.subtotalAmount,
                );
              }
            }
          }
          merchantDiscount = Math.min(merchantDiscount, sellerSubtotal);
          const sellerTotal = Math.max(
            0,
            sellerSubtotal + sellerShipping + sellerTax - merchantDiscount,
          );

          const sellerOrder = await txRepo.createSellerOrder({
            id: sellerOrderId,
            customerOrderId: customerOrderIdInner,
            sellerTenantId: merchantTenantId,
            status: 'PAID',
            currency: checkout.currency,
            subtotalAmount: sellerSubtotal,
            discountAmount: merchantDiscount,
            shippingAmount: sellerShipping,
            taxAmount: sellerTax,
            totalAmount: sellerTotal,
          });
          createdSellerOrdersInner.push(sellerOrder);

          for (const snap of snaps) {
            const orderItemId = randomUUID();
            const orderItem = await txRepo.createOrderItem({
              id: orderItemId,
              sellerOrderId,
              customerOrderId: customerOrderIdInner,
              listingId: snap.item.listingId,
              skuId: snap.item.skuId,
              productId: snap.productId,
              merchantTenantId,
              productName: snap.productName,
              skuCode: snap.skuCode,
              variantInfo: snap.variantInfo,
              quantity: snap.item.quantity,
              unitPriceAmount: snap.item.unitPriceAmount,
              lineTotalAmount: snap.item.lineTotalAmount,
              currency: snap.item.currency,
              inventoryReservationId: snap.item.inventoryReservationId ?? null,
            });
            createdOrderItemsInner.push(orderItem);
          }
        }

        // Finalize promotion and coupon redemptions under transaction lock
        if (this.promotionService) {
          await this.promotionService.finalizeRedemption(tx, {
            checkoutSessionId: checkout.id,
            customerOrderId: customerOrderIdInner,
            customerTenantId: actor.tenantId,
            actor,
          });
        }

        // Analytics + notification fan-out, atomically with the order itself.
        // One ORDER_CREATED + PAYMENT_SUCCEEDED per seller order so each
        // merchant's facts are attributed to their own tenant.
        if (this.outboxService) {
          let customerEmail: string | undefined;
          try {
            const userRes = await tx.query<{ email: string }>(
              'SELECT email FROM users WHERE id = $1',
              [actor.userId],
            );
            customerEmail = userRes.rows[0]?.email;
          } catch {
            // Non-fatal if user email lookup fails
          }

          for (const [merchantTenantId, snaps] of itemsByMerchant.entries()) {
            const sellerOrder = createdSellerOrdersInner.find(
              (s) => s.seller_tenant_id === merchantTenantId,
            )!;
            const sellerTotal = snaps.reduce((sum, s) => sum + s.item.lineTotalAmount, 0);
            await this.outboxService.recordEvent(
              tx,
              createDomainEvent({
                eventType: EventTypes.ORDER_CREATED,
                aggregateType: 'order',
                aggregateId: sellerOrder.id,
                tenantId: merchantTenantId,
                payload: {
                  orderId: sellerOrder.id,
                  customerOrderId: customerOrderIdInner,
                  customerId: actor.tenantId,
                  customerEmail,
                  merchantId: merchantTenantId,
                  currency: checkout.currency,
                  totalAmount: sellerTotal,
                  status: 'PAID',
                  createdAt: new Date().toISOString(),
                  items: snaps.map((s) => ({
                    sellerOrderId: sellerOrder.id,
                    merchantId: merchantTenantId,
                    productId: s.productId,
                    sku: s.skuCode,
                    listingId: s.item.listingId,
                    quantity: s.item.quantity,
                    unitPrice: s.item.unitPriceAmount,
                    price: s.item.unitPriceAmount,
                  })),
                },
              }),
            );
            await this.outboxService.recordEvent(
              tx,
              createDomainEvent({
                eventType: EventTypes.PAYMENT_SUCCEEDED,
                aggregateType: 'payment_intent',
                aggregateId: payment.id,
                tenantId: merchantTenantId,
                payload: {
                  paymentIntentId: payment.id,
                  orderId: sellerOrder.id,
                  customerOrderId: customerOrderIdInner,
                  customerId: actor.tenantId,
                  customerEmail,
                  merchantId: merchantTenantId,
                  amount: sellerTotal,
                  currency: checkout.currency,
                },
              }),
            );
          }
        }

        return { customerOrderRowInner, createdSellerOrdersInner, createdOrderItemsInner };
      });
      customerOrderRow = result.customerOrderRowInner;
      createdSellerOrders = result.createdSellerOrdersInner;
      createdOrderItems = result.createdOrderItemsInner;
    } catch (err: unknown) {
      // Race condition recovery on unique constraints
      if (
        err instanceof Error &&
        (err.message.includes('checkout_session_id') ||
          err.message.includes('uq_customer_order_idempotency') ||
          (err as { code?: string }).code === '23505')
      ) {
        if (input.idempotencyKey) {
          const existingByKey = await this.repo.findCustomerOrderByIdempotency(
            actor.tenantId,
            input.idempotencyKey,
          );
          if (
            existingByKey &&
            (existingByKey.checkout_session_id !== checkout.id ||
              existingByKey.payment_intent_id !== payment.id)
          ) {
            throw new ValidationError(
              `Order idempotency key '${input.idempotencyKey}' reuse with different checkout or payment intent`,
            );
          }
        }
        const existing = await this.repo.findCustomerOrderByCheckoutSession(checkout.id);
        if (existing) {
          await this.consumeReservations(actor, existing.id, checkout.items);
          return this.assembleFullOrderDto(existing);
        }
      }
      throw err;
    }

    // 6. Transition Inventory Reservations from ACTIVE to CONSUMED via Public Inventory API
    await this.consumeReservations(actor, customerOrderRow.id, checkout.items);

    // 7. Link payment intent to the finalized customer order
    try {
      await this.paymentService.linkOrderToIntent(payment.id, customerOrderRow.id);
    } catch {
      this.logger.warn('Failed to link order ID back to payment intent', {
        orderId: customerOrderRow.id,
        paymentIntentId: payment.id,
      });
    }

    // 8. Empty the customer's cart — its items now live on the order.
    // Best-effort: an order must never fail because the cart cleanup did.
    try {
      await this.db.query(
        `DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE tenant_id = $1)`,
        [actor.tenantId],
      );
    } catch (err: unknown) {
      this.logger.warn('Failed to clear cart after order placement', {
        orderId: customerOrderRow.id,
        tenantId: actor.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return this.assembleFullOrderDto(customerOrderRow, createdSellerOrders, createdOrderItems);
  }

  async getCustomerOrder(actor: AuthorizedActor, id: string): Promise<CustomerOrderDto> {
    const order = await this.repo.findCustomerOrderById(id);
    if (!order) {
      throw new NotFoundError(`Customer order '${id}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'order:read-own');
      RbacPolicy.requireTenantMatch(actor, order.customer_tenant_id);
    }

    return this.assembleFullOrderDto(order);
  }

  async listCustomerOrders(
    actor: AuthorizedActor,
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<CustomerOrderDto[]> {
    if (actor.role === 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'order:read-any');
    } else {
      RbacPolicy.requirePermission(actor, 'order:read-own');
    }

    const rows =
      actor.role === 'ADMINISTRATOR'
        ? await this.repo.listAllCustomerOrders(filter)
        : await this.repo.listCustomerOrdersByCustomer(actor.tenantId, filter);
    const methods = await this.paymentMethodsForOrders(rows);
    const result: CustomerOrderDto[] = [];
    for (const r of rows) {
      result.push(
        await this.assembleFullOrderDto(
          r,
          undefined,
          undefined,
          methods.get(r.payment_intent_id ?? '') ?? null,
        ),
      );
    }
    return result;
  }

  /** Single-query lookup of settlement methods for a batch of orders. */
  private async paymentMethodsForOrders(
    rows: CustomerOrderRow[],
  ): Promise<Map<string, 'COD' | 'UPI' | 'CARD' | null>> {
    const ids = [...new Set(rows.map((r) => r.payment_intent_id).filter((v): v is string => !!v))];
    const map = new Map<string, 'COD' | 'UPI' | 'CARD' | null>();
    if (ids.length === 0) return map;
    // Expanded IN list (not ANY($1)): pg-mem cannot bind array parameters.
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const res = await this.db.query<{ id: string; metadata: unknown }>(
      `SELECT id, metadata FROM payment_intents WHERE id IN (${placeholders})`,
      ids,
    );
    for (const row of res.rows) {
      map.set(row.id, paymentMethodFromMetadata(row.metadata));
    }
    return map;
  }

  async getSellerOrder(actor: AuthorizedActor, id: string): Promise<SellerOrderDto> {
    const sellerOrder = await this.repo.findSellerOrderById(id);
    if (!sellerOrder) {
      throw new NotFoundError(`Seller order '${id}' not found`);
    }

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'order:read-seller-own');
      RbacPolicy.requireTenantMatch(actor, sellerOrder.seller_tenant_id);
    }

    const items = await this.repo.findOrderItemsBySellerOrder(sellerOrder.id);
    const custOrder = await this.repo.findCustomerOrderById(sellerOrder.customer_order_id);
    const shippingAddress = custOrder?.shipping_address
      ? typeof custOrder.shipping_address === 'string'
        ? JSON.parse(custOrder.shipping_address)
        : (custOrder.shipping_address as AddressSnapshot)
      : null;
    return this.toSellerOrderDto(sellerOrder, items, undefined, shippingAddress);
  }

  async listSellerOrders(
    actor: AuthorizedActor,
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<SellerOrderDto[]> {
    RbacPolicy.requirePermission(actor, 'order:read-seller-own');

    const rows = await this.repo.listSellerOrdersBySeller(actor.tenantId, filter);
    const result: SellerOrderDto[] = [];
    for (const r of rows) {
      const items = await this.repo.findOrderItemsBySellerOrder(r.id);
      const custOrder = await this.repo.findCustomerOrderById(r.customer_order_id);
      const shippingAddress = custOrder?.shipping_address
        ? typeof custOrder.shipping_address === 'string'
          ? JSON.parse(custOrder.shipping_address)
          : (custOrder.shipping_address as AddressSnapshot)
        : null;
      result.push(this.toSellerOrderDto(r, items, undefined, shippingAddress));
    }
    return result;
  }

  async updateCustomerOrderStatus(
    actor: AuthorizedActor,
    orderId: string,
    nextStatus: CustomerOrderStatus,
  ): Promise<CustomerOrderDto> {
    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'order:manage-any');
    }

    const current = await this.repo.findCustomerOrderById(orderId);
    if (!current) throw new NotFoundError(`Customer order '${orderId}' not found`);

    // State machine transitions:
    // PENDING_PAYMENT -> PAID, CANCELLED
    // PAID -> PROCESSING, CANCELLED
    // PROCESSING -> COMPLETED, CANCELLED
    // COMPLETED -> (terminal)
    // CANCELLED -> (terminal)
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

    const updated = await this.repo.updateCustomerOrderStatus(orderId, current.status, nextStatus);
    if (!updated) {
      throw new InvalidStateTransitionError(
        'Concurrent modification conflict on order status update',
      );
    }

    return this.assembleFullOrderDto(updated);
  }

  async updateSellerOrderStatus(
    actor: AuthorizedActor,
    sellerOrderId: string,
    nextStatus: SellerOrderStatus,
  ): Promise<SellerOrderDto> {
    const current = await this.repo.findSellerOrderById(sellerOrderId);
    if (!current) throw new NotFoundError(`Seller order '${sellerOrderId}' not found`);

    if (actor.role !== 'ADMINISTRATOR') {
      RbacPolicy.requirePermission(actor, 'order:read-seller-own');
      RbacPolicy.requireTenantMatch(actor, current.seller_tenant_id);
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

    const updated = await this.repo.updateSellerOrderStatus(
      sellerOrderId,
      current.status,
      nextStatus,
    );
    if (!updated) {
      throw new InvalidStateTransitionError(
        'Concurrent modification conflict on seller order status update',
      );
    }

    const items = await this.repo.findOrderItemsBySellerOrder(sellerOrderId);
    return this.toSellerOrderDto(updated, items);
  }

  private async assembleFullOrderDto(
    order: CustomerOrderRow,
    prefetchedSellerOrders?: SellerOrderRow[] | undefined,
    prefetchedItems?: OrderItemRow[] | undefined,
    paymentMethod?: 'COD' | 'UPI' | 'CARD' | null | undefined,
  ): Promise<CustomerOrderDto> {
    const sellerOrders =
      prefetchedSellerOrders ?? (await this.repo.findSellerOrdersByCustomerOrder(order.id));
    const items = prefetchedItems ?? (await this.repo.findOrderItemsByCustomerOrder(order.id));
    const thumbnails = await this.productThumbnailsForItems(items);

    const sellerDtos = sellerOrders.map((s) => {
      const sItems = items.filter((it) => it.seller_order_id === s.id);
      return this.toSellerOrderDto(s, sItems, thumbnails);
    });

    let method = paymentMethod;
    if (method === undefined && order.payment_intent_id) {
      const methods = await this.paymentMethodsForOrders([order]);
      method = methods.get(order.payment_intent_id) ?? null;
    }

    return {
      id: order.id,
      customerTenantId: order.customer_tenant_id,
      checkoutSessionId: order.checkout_session_id,
      paymentIntentId: order.payment_intent_id,
      paymentMethod: method ?? null,
      status: order.status,
      currency: order.currency,
      subtotalAmount: order.subtotal_amount,
      discountAmount: order.discount_amount,
      shippingAmount: order.shipping_amount,
      taxAmount: order.tax_amount,
      totalAmount: order.total_amount,
      idempotencyKey: order.idempotency_key,
      couponCode: order.coupon_code ?? null,
      appliedPromotions:
        typeof order.applied_promotions === 'string'
          ? JSON.parse(order.applied_promotions)
          : Array.isArray(order.applied_promotions)
            ? order.applied_promotions
            : [],
      shippingAddress: order.shipping_address
        ? typeof order.shipping_address === 'string'
          ? JSON.parse(order.shipping_address)
          : (order.shipping_address as AddressSnapshot)
        : null,
      createdAt: order.created_at.toISOString(),
      updatedAt: order.updated_at.toISOString(),
      sellerOrders: sellerDtos,
      items: items.map((it) => this.toItemDto(it, thumbnails.get(it.product_id) ?? null)),
    };
  }

  /** Single-query thumbnail lookup for an order's products. */
  private async productThumbnailsForItems(items: OrderItemRow[]): Promise<Map<string, string>> {
    const ids = [...new Set(items.map((it) => it.product_id).filter(Boolean))];
    const map = new Map<string, string>();
    if (ids.length === 0) return map;
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const res = await this.db.query<{ id: string; thumbnail_url: string | null }>(
      `SELECT id, thumbnail_url FROM products WHERE id IN (${placeholders})`,
      ids,
    );
    for (const row of res.rows) {
      if (row.thumbnail_url) map.set(row.id, row.thumbnail_url);
    }
    return map;
  }

  private toSellerOrderDto(
    row: SellerOrderRow,
    items: OrderItemRow[] = [],
    thumbnails?: Map<string, string> | undefined,
    shippingAddress?: AddressSnapshot | null | undefined,
  ): SellerOrderDto {
    return {
      id: row.id,
      customerOrderId: row.customer_order_id,
      sellerTenantId: row.seller_tenant_id,
      status: row.status,
      currency: row.currency,
      subtotalAmount: row.subtotal_amount,
      discountAmount: Number(row.discount_amount ?? 0),
      shippingAmount: row.shipping_amount,
      taxAmount: row.tax_amount,
      totalAmount: row.total_amount,
      shippingAddress: shippingAddress ?? null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      items: items.map((it) => this.toItemDto(it, thumbnails?.get(it.product_id) ?? null)),
    };
  }

  private toItemDto(row: OrderItemRow, thumbnailUrl?: string | null): OrderItemDto {
    return {
      id: row.id,
      sellerOrderId: row.seller_order_id,
      customerOrderId: row.customer_order_id,
      listingId: row.listing_id,
      skuId: row.sku_id,
      productId: row.product_id,
      merchantTenantId: row.merchant_tenant_id,
      productName: row.product_name,
      productThumbnailUrl: thumbnailUrl ?? null,
      skuCode: row.sku_code,
      variantInfo: row.variant_info,
      quantity: row.quantity,
      unitPriceAmount: row.unit_price_amount,
      lineTotalAmount: row.line_total_amount,
      currency: row.currency,
      inventoryReservationId: row.inventory_reservation_id,
      createdAt: row.created_at.toISOString(),
    };
  }
}
