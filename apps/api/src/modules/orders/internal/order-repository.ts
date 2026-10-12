import type { DatabaseConnection } from '../../../infra/database/connection.js';

export type CustomerOrderStatus =
  'PENDING_PAYMENT' | 'PAID' | 'PROCESSING' | 'COMPLETED' | 'CANCELLED';

export type SellerOrderStatus =
  'PENDING_PAYMENT' | 'PAID' | 'PROCESSING' | 'COMPLETED' | 'CANCELLED';

export interface CustomerOrderRow {
  id: string;
  customer_tenant_id: string;
  checkout_session_id: string;
  payment_intent_id: string | null;
  status: CustomerOrderStatus;
  currency: string;
  subtotal_amount: number;
  discount_amount: number;
  shipping_amount: number;
  tax_amount: number;
  total_amount: number;
  idempotency_key: string | null;
  coupon_code?: string | null;
  applied_promotions?: unknown;
  shipping_address?: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface SellerOrderRow {
  id: string;
  customer_order_id: string;
  seller_tenant_id: string;
  status: SellerOrderStatus;
  currency: string;
  subtotal_amount: number;
  discount_amount?: number;
  shipping_amount: number;
  tax_amount: number;
  total_amount: number;
  created_at: Date;
  updated_at: Date;
}

export interface OrderItemRow {
  id: string;
  seller_order_id: string;
  customer_order_id: string;
  listing_id: string;
  sku_id: string;
  product_id: string;
  merchant_tenant_id: string;
  product_name: string;
  sku_code: string;
  variant_info: Record<string, unknown>;
  quantity: number;
  unit_price_amount: number;
  line_total_amount: number;
  currency: string;
  inventory_reservation_id: string | null;
  created_at: Date;
}

export class OrderRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async createCustomerOrder(data: {
    id: string;
    customerTenantId: string;
    checkoutSessionId: string;
    paymentIntentId?: string | null | undefined;
    status: CustomerOrderStatus;
    currency: string;
    subtotalAmount: number;
    discountAmount?: number | undefined;
    shippingAmount?: number | undefined;
    taxAmount?: number | undefined;
    totalAmount: number;
    idempotencyKey?: string | null | undefined;
    couponCode?: string | null | undefined;
    appliedPromotions?: unknown;
    shippingAddress?: unknown;
  }): Promise<CustomerOrderRow> {
    const res = await this.db.query<CustomerOrderRow>(
      `INSERT INTO customer_orders (
        id, customer_tenant_id, checkout_session_id, payment_intent_id,
        status, currency, subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount,
        idempotency_key, coupon_code, applied_promotions, shipping_address
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb)
      RETURNING id, customer_tenant_id, checkout_session_id, payment_intent_id,
                status, currency, subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount,
                idempotency_key, coupon_code, applied_promotions, shipping_address, created_at, updated_at`,
      [
        data.id,
        data.customerTenantId,
        data.checkoutSessionId,
        data.paymentIntentId ?? null,
        data.status,
        data.currency,
        data.subtotalAmount,
        data.discountAmount ?? 0,
        data.shippingAmount ?? 0,
        data.taxAmount ?? 0,
        data.totalAmount,
        data.idempotencyKey ?? null,
        data.couponCode ?? null,
        JSON.stringify(data.appliedPromotions ?? []),
        data.shippingAddress ? JSON.stringify(data.shippingAddress) : null,
      ],
    );
    return res.rows[0]!;
  }

  async findCustomerOrderById(id: string): Promise<CustomerOrderRow | null> {
    const res = await this.db.query<CustomerOrderRow>(
      `SELECT id, customer_tenant_id, checkout_session_id, payment_intent_id,
              status, currency, subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount,
              idempotency_key, coupon_code, applied_promotions, shipping_address, created_at, updated_at
       FROM customer_orders
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findCustomerOrderByCheckoutSession(
    checkoutSessionId: string,
  ): Promise<CustomerOrderRow | null> {
    const res = await this.db.query<CustomerOrderRow>(
      `SELECT id, customer_tenant_id, checkout_session_id, payment_intent_id,
              status, currency, subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount,
              idempotency_key, coupon_code, applied_promotions, shipping_address, created_at, updated_at
       FROM customer_orders
       WHERE checkout_session_id = $1`,
      [checkoutSessionId],
    );
    return res.rows[0] ?? null;
  }

  async findCustomerOrderByIdempotency(
    customerTenantId: string,
    idempotencyKey: string,
  ): Promise<CustomerOrderRow | null> {
    const res = await this.db.query<CustomerOrderRow>(
      `SELECT id, customer_tenant_id, checkout_session_id, payment_intent_id,
              status, currency, subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount,
              idempotency_key, coupon_code, applied_promotions, shipping_address, created_at, updated_at
       FROM customer_orders
       WHERE customer_tenant_id = $1 AND idempotency_key = $2`,
      [customerTenantId, idempotencyKey],
    );
    return res.rows[0] ?? null;
  }

  async listCustomerOrdersByCustomer(
    customerTenantId: string,
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<CustomerOrderRow[]> {
    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;
    const res = await this.db.query<CustomerOrderRow>(
      `SELECT id, customer_tenant_id, checkout_session_id, payment_intent_id,
              status, currency, subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount,
              idempotency_key, coupon_code, applied_promotions, shipping_address, created_at, updated_at
       FROM customer_orders
       WHERE customer_tenant_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [customerTenantId, limit, offset],
    );
    return res.rows;
  }

  async listAllCustomerOrders(
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<CustomerOrderRow[]> {
    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;
    const res = await this.db.query<CustomerOrderRow>(
      `SELECT id, customer_tenant_id, checkout_session_id, payment_intent_id,
              status, currency, subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount,
              idempotency_key, coupon_code, applied_promotions, shipping_address, created_at, updated_at
       FROM customer_orders
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return res.rows;
  }

  async updateCustomerOrderStatus(
    id: string,
    expectedStatus: CustomerOrderStatus | CustomerOrderStatus[],
    nextStatus: CustomerOrderStatus,
  ): Promise<CustomerOrderRow | null> {
    const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    const placeholders = allowed.map((_, i) => `$${i + 3}`).join(', ');

    const res = await this.db.query<CustomerOrderRow>(
      `UPDATE customer_orders
       SET status = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status IN (${placeholders})
       RETURNING id, customer_tenant_id, checkout_session_id, payment_intent_id,
                 status, currency, subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount,
                 idempotency_key, coupon_code, applied_promotions, shipping_address, created_at, updated_at`,
      [id, nextStatus, ...allowed],
    );
    return res.rows[0] ?? null;
  }

  async createSellerOrder(data: {
    id: string;
    customerOrderId: string;
    sellerTenantId: string;
    status: SellerOrderStatus;
    currency: string;
    subtotalAmount: number;
    discountAmount?: number | undefined;
    shippingAmount?: number | undefined;
    taxAmount?: number | undefined;
    totalAmount: number;
  }): Promise<SellerOrderRow> {
    const res = await this.db.query<SellerOrderRow>(
      `INSERT INTO seller_orders (
        id, customer_order_id, seller_tenant_id, status, currency,
        subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, customer_order_id, seller_tenant_id, status, currency,
                subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount, created_at, updated_at`,
      [
        data.id,
        data.customerOrderId,
        data.sellerTenantId,
        data.status,
        data.currency,
        data.subtotalAmount,
        data.discountAmount ?? 0,
        data.shippingAmount ?? 0,
        data.taxAmount ?? 0,
        data.totalAmount,
      ],
    );
    return res.rows[0]!;
  }

  async findSellerOrdersByCustomerOrder(customerOrderId: string): Promise<SellerOrderRow[]> {
    const res = await this.db.query<SellerOrderRow>(
      `SELECT id, customer_order_id, seller_tenant_id, status, currency,
              subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount, created_at, updated_at
       FROM seller_orders
       WHERE customer_order_id = $1
       ORDER BY created_at ASC`,
      [customerOrderId],
    );
    return res.rows;
  }

  async findSellerOrderById(id: string): Promise<SellerOrderRow | null> {
    const res = await this.db.query<SellerOrderRow>(
      `SELECT id, customer_order_id, seller_tenant_id, status, currency,
              subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount, created_at, updated_at
       FROM seller_orders
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async listSellerOrdersBySeller(
    sellerTenantId: string,
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<SellerOrderRow[]> {
    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;
    const res = await this.db.query<SellerOrderRow>(
      `SELECT id, customer_order_id, seller_tenant_id, status, currency,
              subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount, created_at, updated_at
       FROM seller_orders
       WHERE seller_tenant_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [sellerTenantId, limit, offset],
    );
    return res.rows;
  }

  async updateSellerOrderStatus(
    id: string,
    expectedStatus: SellerOrderStatus | SellerOrderStatus[],
    nextStatus: SellerOrderStatus,
  ): Promise<SellerOrderRow | null> {
    const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    const placeholders = allowed.map((_, i) => `$${i + 3}`).join(', ');

    const res = await this.db.query<SellerOrderRow>(
      `UPDATE seller_orders
       SET status = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status IN (${placeholders})
       RETURNING id, customer_order_id, seller_tenant_id, status, currency,
                 subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount, created_at, updated_at`,
      [id, nextStatus, ...allowed],
    );
    return res.rows[0] ?? null;
  }

  async createOrderItem(data: {
    id: string;
    sellerOrderId: string;
    customerOrderId: string;
    listingId: string;
    skuId: string;
    productId: string;
    merchantTenantId: string;
    productName: string;
    skuCode: string;
    variantInfo: Record<string, unknown>;
    quantity: number;
    unitPriceAmount: number;
    lineTotalAmount: number;
    currency: string;
    inventoryReservationId?: string | null | undefined;
  }): Promise<OrderItemRow> {
    const res = await this.db.query<OrderItemRow>(
      `INSERT INTO order_items (
        id, seller_order_id, customer_order_id, listing_id, sku_id, product_id,
        merchant_tenant_id, product_name, sku_code, variant_info, quantity,
        unit_price_amount, line_total_amount, currency, inventory_reservation_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id, seller_order_id, customer_order_id, listing_id, sku_id, product_id,
                merchant_tenant_id, product_name, sku_code, variant_info, quantity,
                unit_price_amount, line_total_amount, currency, inventory_reservation_id, created_at`,
      [
        data.id,
        data.sellerOrderId,
        data.customerOrderId,
        data.listingId,
        data.skuId,
        data.productId,
        data.merchantTenantId,
        data.productName,
        data.skuCode,
        JSON.stringify(data.variantInfo),
        data.quantity,
        data.unitPriceAmount,
        data.lineTotalAmount,
        data.currency,
        data.inventoryReservationId ?? null,
      ],
    );
    return res.rows[0]!;
  }

  async findOrderItemsByCustomerOrder(customerOrderId: string): Promise<OrderItemRow[]> {
    const res = await this.db.query<OrderItemRow>(
      `SELECT id, seller_order_id, customer_order_id, listing_id, sku_id, product_id,
              merchant_tenant_id, product_name, sku_code, variant_info, quantity,
              unit_price_amount, line_total_amount, currency, inventory_reservation_id, created_at
       FROM order_items
       WHERE customer_order_id = $1
       ORDER BY created_at ASC`,
      [customerOrderId],
    );
    return res.rows;
  }

  async findOrderItemsBySellerOrder(sellerOrderId: string): Promise<OrderItemRow[]> {
    const res = await this.db.query<OrderItemRow>(
      `SELECT id, seller_order_id, customer_order_id, listing_id, sku_id, product_id,
              merchant_tenant_id, product_name, sku_code, variant_info, quantity,
              unit_price_amount, line_total_amount, currency, inventory_reservation_id, created_at
       FROM order_items
       WHERE seller_order_id = $1
       ORDER BY created_at ASC`,
      [sellerOrderId],
    );
    return res.rows;
  }
}
