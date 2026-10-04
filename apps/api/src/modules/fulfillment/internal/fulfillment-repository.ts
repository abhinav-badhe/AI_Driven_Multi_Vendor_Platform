import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { ShipmentStatus } from './carrier-provider.js';

export type { ShipmentStatus };

export type ReturnStatus =
  | 'REQUESTED'
  | 'APPROVED'
  | 'IN_TRANSIT'
  | 'RECEIVED'
  | 'COMPLETED'
  | 'REJECTED'
  | 'CANCELLED';

export interface ShipmentRow {
  id: string;
  seller_order_id: string;
  customer_order_id: string;
  seller_tenant_id: string;
  status: ShipmentStatus;
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipped_at: Date | null;
  delivered_at: Date | null;
  estimated_delivery_at: Date | null;
  idempotency_key: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface ShipmentItemRow {
  id: string;
  shipment_id: string;
  order_item_id: string;
  quantity: number;
  created_at: Date;
}

export interface ReturnRow {
  id: string;
  customer_tenant_id: string;
  customer_order_id: string;
  seller_order_id: string;
  seller_tenant_id: string;
  status: ReturnStatus;
  reason: string;
  requested_at: Date;
  approved_at: Date | null;
  rejected_at: Date | null;
  received_at: Date | null;
  completed_at: Date | null;
  refund_id: string | null;
  idempotency_key: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface ReturnItemRow {
  id: string;
  return_id: string;
  order_item_id: string;
  quantity: number;
  reason: string | null;
  created_at: Date;
}

export class FulfillmentRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async createShipment(data: {
    id: string;
    sellerOrderId: string;
    customerOrderId: string;
    sellerTenantId: string;
    status?: ShipmentStatus | undefined;
    carrier?: string | null | undefined;
    trackingNumber?: string | null | undefined;
    trackingUrl?: string | null | undefined;
    idempotencyKey?: string | null | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<ShipmentRow> {
    const res = await this.db.query<ShipmentRow>(
      `INSERT INTO shipments (
        id, seller_order_id, customer_order_id, seller_tenant_id, status,
        carrier, tracking_number, tracking_url, idempotency_key, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, seller_order_id, customer_order_id, seller_tenant_id, status,
                carrier, tracking_number, tracking_url, shipped_at, delivered_at,
                estimated_delivery_at, idempotency_key, metadata, created_at, updated_at`,
      [
        data.id,
        data.sellerOrderId,
        data.customerOrderId,
        data.sellerTenantId,
        data.status ?? 'PENDING',
        data.carrier ?? null,
        data.trackingNumber ?? null,
        data.trackingUrl ?? null,
        data.idempotencyKey ?? null,
        JSON.stringify(data.metadata ?? {}),
      ],
    );
    return res.rows[0]!;
  }

  async createShipmentItem(data: {
    id: string;
    shipmentId: string;
    orderItemId: string;
    quantity: number;
  }): Promise<ShipmentItemRow> {
    const res = await this.db.query<ShipmentItemRow>(
      `INSERT INTO shipment_items (id, shipment_id, order_item_id, quantity)
       VALUES ($1, $2, $3, $4)
       RETURNING id, shipment_id, order_item_id, quantity, created_at`,
      [data.id, data.shipmentId, data.orderItemId, data.quantity],
    );
    return res.rows[0]!;
  }

  async findShipmentById(id: string): Promise<ShipmentRow | null> {
    const res = await this.db.query<ShipmentRow>(
      `SELECT id, seller_order_id, customer_order_id, seller_tenant_id, status,
              carrier, tracking_number, tracking_url, shipped_at, delivered_at,
              estimated_delivery_at, idempotency_key, metadata, created_at, updated_at
       FROM shipments
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findShipmentByIdempotency(
    sellerTenantId: string,
    idempotencyKey: string,
  ): Promise<ShipmentRow | null> {
    const res = await this.db.query<ShipmentRow>(
      `SELECT id, seller_order_id, customer_order_id, seller_tenant_id, status,
              carrier, tracking_number, tracking_url, shipped_at, delivered_at,
              estimated_delivery_at, idempotency_key, metadata, created_at, updated_at
       FROM shipments
       WHERE seller_tenant_id = $1 AND idempotency_key = $2`,
      [sellerTenantId, idempotencyKey],
    );
    return res.rows[0] ?? null;
  }


  async findShipmentsBySellerOrder(sellerOrderId: string): Promise<ShipmentRow[]> {
    const res = await this.db.query<ShipmentRow>(
      `SELECT id, seller_order_id, customer_order_id, seller_tenant_id, status,
              carrier, tracking_number, tracking_url, shipped_at, delivered_at,
              estimated_delivery_at, idempotency_key, metadata, created_at, updated_at
       FROM shipments
       WHERE seller_order_id = $1
       ORDER BY created_at ASC`,
      [sellerOrderId],
    );
    return res.rows;
  }

  async findShipmentsByCustomerOrder(customerOrderId: string): Promise<ShipmentRow[]> {
    const res = await this.db.query<ShipmentRow>(
      `SELECT id, seller_order_id, customer_order_id, seller_tenant_id, status,
              carrier, tracking_number, tracking_url, shipped_at, delivered_at,
              estimated_delivery_at, idempotency_key, metadata, created_at, updated_at
       FROM shipments
       WHERE customer_order_id = $1
       ORDER BY created_at ASC`,
      [customerOrderId],
    );
    return res.rows;
  }

  async findShipmentsBySellerTenant(
    sellerTenantId: string,
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<ShipmentRow[]> {
    let query = `SELECT id, seller_order_id, customer_order_id, seller_tenant_id, status,
                        carrier, tracking_number, tracking_url, shipped_at, delivered_at,
                        estimated_delivery_at, idempotency_key, metadata, created_at, updated_at
                 FROM shipments
                 WHERE seller_tenant_id = $1
                 ORDER BY created_at DESC`;
    const params: unknown[] = [sellerTenantId];
    if (filter?.limit) {
      params.push(filter.limit);
      query += ` LIMIT $${params.length}`;
    }
    if (filter?.offset) {
      params.push(filter.offset);
      query += ` OFFSET $${params.length}`;
    }
    const res = await this.db.query<ShipmentRow>(query, params);
    return res.rows;
  }

  async findShipmentItemsByShipment(shipmentId: string): Promise<ShipmentItemRow[]> {
    const res = await this.db.query<ShipmentItemRow>(
      `SELECT id, shipment_id, order_item_id, quantity, created_at
       FROM shipment_items
       WHERE shipment_id = $1
       ORDER BY created_at ASC`,
      [shipmentId],
    );
    return res.rows;
  }

  async findShipmentByTracking(carrier: string, trackingNumber: string): Promise<ShipmentRow | null> {
    const res = await this.db.query<ShipmentRow>(
      `SELECT id, seller_order_id, customer_order_id, seller_tenant_id, status,
              carrier, tracking_number, tracking_url, shipped_at, delivered_at,
              estimated_delivery_at, idempotency_key, metadata, created_at, updated_at
       FROM shipments
       WHERE carrier = $1 AND tracking_number = $2
       LIMIT 1`,
      [carrier, trackingNumber],
    );
    return res.rows[0] ?? null;
  }

  async getTotalFulfilledQuantityByOrderItem(
    orderItemId: string,
    excludeShipmentId?: string | undefined,
  ): Promise<number> {
    let query = `
      SELECT COALESCE(SUM(si.quantity), 0) AS total
      FROM shipment_items si
      JOIN shipments s ON si.shipment_id = s.id
      WHERE si.order_item_id = $1 AND s.status != 'CANCELLED'
    `;
    const params: unknown[] = [orderItemId];
    if (excludeShipmentId) {
      params.push(excludeShipmentId);
      query += ` AND s.id != $${params.length}`;
    }
    const res = await this.db.query<{ total: string | number }>(query, params);
    return parseInt(String(res.rows[0]?.total ?? 0), 10);
  }

  async getTotalDeliveredQuantityByOrderItem(orderItemId: string): Promise<number> {
    const res = await this.db.query<{ total: string | number }>(
      `SELECT COALESCE(SUM(si.quantity), 0) AS total
       FROM shipment_items si
       JOIN shipments s ON si.shipment_id = s.id
       WHERE si.order_item_id = $1 AND s.status = 'DELIVERED'`,
      [orderItemId],
    );
    return parseInt(String(res.rows[0]?.total ?? 0), 10);
  }

  async updateShipmentStatus(
    id: string,
    allowedCurrentStatuses: ShipmentStatus | ShipmentStatus[],
    newStatus: ShipmentStatus,
    extra?: {
      shippedAt?: Date | undefined;
      deliveredAt?: Date | undefined;
      metadata?: Record<string, unknown> | undefined;
    } | undefined,
  ): Promise<ShipmentRow | null> {
    const allowed = Array.isArray(allowedCurrentStatuses)
      ? allowedCurrentStatuses
      : [allowedCurrentStatuses];
    const params: unknown[] = [id, newStatus];

    let query = `UPDATE shipments SET status = $2, updated_at = CURRENT_TIMESTAMP`;

    if (extra?.shippedAt !== undefined) {
      params.push(extra.shippedAt);
      query += `, shipped_at = $${params.length}`;
    }
    if (extra?.deliveredAt !== undefined) {
      params.push(extra.deliveredAt);
      query += `, delivered_at = $${params.length}`;
    }
    if (extra?.metadata !== undefined) {
      params.push(JSON.stringify(extra.metadata));
      query += `, metadata = $${params.length}`;
    }

    const placeholders = allowed.map((s) => {
      params.push(s);
      return `$${params.length}`;
    }).join(', ');

    query += ` WHERE id = $1 AND status IN (${placeholders})
      RETURNING id, seller_order_id, customer_order_id, seller_tenant_id, status,
                carrier, tracking_number, tracking_url, shipped_at, delivered_at,
                estimated_delivery_at, idempotency_key, metadata, created_at, updated_at`;

    const res = await this.db.query<ShipmentRow>(query, params);
    return res.rows[0] ?? null;
  }

  async updateShipmentTracking(
    id: string,
    carrier: string,
    trackingNumber: string,
    trackingUrl?: string | null | undefined,
  ): Promise<ShipmentRow | null> {
    const res = await this.db.query<ShipmentRow>(
      `UPDATE shipments
       SET carrier = $2, tracking_number = $3, tracking_url = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, seller_order_id, customer_order_id, seller_tenant_id, status,
                 carrier, tracking_number, tracking_url, shipped_at, delivered_at,
                 estimated_delivery_at, idempotency_key, metadata, created_at, updated_at`,
      [id, carrier, trackingNumber, trackingUrl ?? null],
    );
    return res.rows[0] ?? null;
  }

  // --- RETURNS ---

  async createReturn(data: {
    id: string;
    customerTenantId: string;
    customerOrderId: string;
    sellerOrderId: string;
    sellerTenantId: string;
    reason: string;
    status?: ReturnStatus | undefined;
    idempotencyKey?: string | null | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<ReturnRow> {
    const res = await this.db.query<ReturnRow>(
      `INSERT INTO returns (
        id, customer_tenant_id, customer_order_id, seller_order_id, seller_tenant_id,
        reason, status, idempotency_key, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, customer_tenant_id, customer_order_id, seller_order_id, seller_tenant_id,
                status, reason, requested_at, approved_at, rejected_at, received_at,
                completed_at, refund_id, idempotency_key, metadata, created_at, updated_at`,
      [
        data.id,
        data.customerTenantId,
        data.customerOrderId,
        data.sellerOrderId,
        data.sellerTenantId,
        data.reason,
        data.status ?? 'REQUESTED',
        data.idempotencyKey ?? null,
        JSON.stringify(data.metadata ?? {}),
      ],
    );
    return res.rows[0]!;
  }

  async createReturnItem(data: {
    id: string;
    returnId: string;
    orderItemId: string;
    quantity: number;
    reason?: string | null | undefined;
  }): Promise<ReturnItemRow> {
    const res = await this.db.query<ReturnItemRow>(
      `INSERT INTO return_items (id, return_id, order_item_id, quantity, reason)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, return_id, order_item_id, quantity, reason, created_at`,
      [data.id, data.returnId, data.orderItemId, data.quantity, data.reason ?? null],
    );
    return res.rows[0]!;
  }

  async findReturnById(id: string): Promise<ReturnRow | null> {
    const res = await this.db.query<ReturnRow>(
      `SELECT id, customer_tenant_id, customer_order_id, seller_order_id, seller_tenant_id,
              status, reason, requested_at, approved_at, rejected_at, received_at,
              completed_at, refund_id, idempotency_key, metadata, created_at, updated_at
       FROM returns
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findReturnByIdempotency(
    customerTenantId: string,
    idempotencyKey: string,
  ): Promise<ReturnRow | null> {
    const res = await this.db.query<ReturnRow>(
      `SELECT id, customer_tenant_id, customer_order_id, seller_order_id, seller_tenant_id,
              status, reason, requested_at, approved_at, rejected_at, received_at,
              completed_at, refund_id, idempotency_key, metadata, created_at, updated_at
       FROM returns
       WHERE customer_tenant_id = $1 AND idempotency_key = $2`,
      [customerTenantId, idempotencyKey],
    );
    return res.rows[0] ?? null;
  }

  async findReturnsByCustomerTenant(
    customerTenantId: string,
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<ReturnRow[]> {
    let query = `SELECT id, customer_tenant_id, customer_order_id, seller_order_id, seller_tenant_id,
                        status, reason, requested_at, approved_at, rejected_at, received_at,
                        completed_at, refund_id, idempotency_key, metadata, created_at, updated_at
                 FROM returns
                 WHERE customer_tenant_id = $1
                 ORDER BY created_at DESC`;
    const params: unknown[] = [customerTenantId];
    if (filter?.limit) {
      params.push(filter.limit);
      query += ` LIMIT $${params.length}`;
    }
    if (filter?.offset) {
      params.push(filter.offset);
      query += ` OFFSET $${params.length}`;
    }
    const res = await this.db.query<ReturnRow>(query, params);
    return res.rows;
  }

  async findReturnsBySellerTenant(
    sellerTenantId: string,
    filter?: { limit?: number | undefined; offset?: number | undefined } | undefined,
  ): Promise<ReturnRow[]> {
    let query = `SELECT id, customer_tenant_id, customer_order_id, seller_order_id, seller_tenant_id,
                        status, reason, requested_at, approved_at, rejected_at, received_at,
                        completed_at, refund_id, idempotency_key, metadata, created_at, updated_at
                 FROM returns
                 WHERE seller_tenant_id = $1
                 ORDER BY created_at DESC`;
    const params: unknown[] = [sellerTenantId];
    if (filter?.limit) {
      params.push(filter.limit);
      query += ` LIMIT $${params.length}`;
    }
    if (filter?.offset) {
      params.push(filter.offset);
      query += ` OFFSET $${params.length}`;
    }
    const res = await this.db.query<ReturnRow>(query, params);
    return res.rows;
  }

  async findReturnItemsByReturn(returnId: string): Promise<ReturnItemRow[]> {
    const res = await this.db.query<ReturnItemRow>(
      `SELECT id, return_id, order_item_id, quantity, reason, created_at
       FROM return_items
       WHERE return_id = $1
       ORDER BY created_at ASC`,
      [returnId],
    );
    return res.rows;
  }

  async getTotalReturnedQuantityByOrderItem(
    orderItemId: string,
    excludeReturnId?: string | undefined,
  ): Promise<number> {
    let query = `
      SELECT COALESCE(SUM(ri.quantity), 0) AS total
      FROM return_items ri
      JOIN returns r ON ri.return_id = r.id
      WHERE ri.order_item_id = $1 AND r.status NOT IN ('REJECTED', 'CANCELLED')
    `;
    const params: unknown[] = [orderItemId];
    if (excludeReturnId) {
      params.push(excludeReturnId);
      query += ` AND r.id != $${params.length}`;
    }
    const res = await this.db.query<{ total: string | number }>(query, params);
    return parseInt(String(res.rows[0]?.total ?? 0), 10);
  }

  async updateReturnStatus(
    id: string,
    allowedCurrentStatuses: ReturnStatus | ReturnStatus[],
    newStatus: ReturnStatus,
    extra?: {
      approvedAt?: Date | undefined;
      rejectedAt?: Date | undefined;
      receivedAt?: Date | undefined;
      completedAt?: Date | undefined;
      refundId?: string | undefined;
      metadata?: Record<string, unknown> | undefined;
    } | undefined,
  ): Promise<ReturnRow | null> {
    const allowed = Array.isArray(allowedCurrentStatuses)
      ? allowedCurrentStatuses
      : [allowedCurrentStatuses];
    const params: unknown[] = [id, newStatus];

    let query = `UPDATE returns SET status = $2, updated_at = CURRENT_TIMESTAMP`;

    if (extra?.approvedAt !== undefined) {
      params.push(extra.approvedAt);
      query += `, approved_at = $${params.length}`;
    }
    if (extra?.rejectedAt !== undefined) {
      params.push(extra.rejectedAt);
      query += `, rejected_at = $${params.length}`;
    }
    if (extra?.receivedAt !== undefined) {
      params.push(extra.receivedAt);
      query += `, received_at = $${params.length}`;
    }
    if (extra?.completedAt !== undefined) {
      params.push(extra.completedAt);
      query += `, completed_at = $${params.length}`;
    }
    if (extra?.refundId !== undefined) {
      params.push(extra.refundId);
      query += `, refund_id = $${params.length}`;
    }
    if (extra?.metadata !== undefined) {
      params.push(JSON.stringify(extra.metadata));
      query += `, metadata = $${params.length}`;
    }

    const placeholders = allowed.map((s) => {
      params.push(s);
      return `$${params.length}`;
    }).join(', ');

    query += ` WHERE id = $1 AND status IN (${placeholders})
      RETURNING id, customer_tenant_id, customer_order_id, seller_order_id, seller_tenant_id,
                status, reason, requested_at, approved_at, rejected_at, received_at,
                completed_at, refund_id, idempotency_key, metadata, created_at, updated_at`;

    const res = await this.db.query<ReturnRow>(query, params);
    return res.rows[0] ?? null;
  }

  async findCarrierWebhookEvent(
    carrier: string,
    providerEventId: string,
  ): Promise<CarrierWebhookEventRow | null> {
    const res = await this.db.query<CarrierWebhookEventRow>(
      `SELECT id, carrier, provider_event_id, tracking_number, status, payload, processed_at
       FROM carrier_webhook_events
       WHERE carrier = $1 AND provider_event_id = $2`,
      [carrier, providerEventId],
    );
    return res.rows[0] ?? null;
  }

  async recordCarrierWebhookEvent(data: {
    id: string;
    carrier: string;
    providerEventId: string;
    trackingNumber: string;
    status: string;
    payload: Record<string, unknown>;
  }): Promise<CarrierWebhookEventRow> {
    const res = await this.db.query<CarrierWebhookEventRow>(
      `INSERT INTO carrier_webhook_events (
        id, carrier, provider_event_id, tracking_number, status, payload
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, carrier, provider_event_id, tracking_number, status, payload, processed_at`,
      [
        data.id,
        data.carrier,
        data.providerEventId,
        data.trackingNumber,
        data.status,
        JSON.stringify(data.payload),
      ],
    );
    return res.rows[0]!;
  }
}

export interface CarrierWebhookEventRow {
  id: string;
  carrier: string;
  provider_event_id: string;
  tracking_number: string;
  status: string;
  payload: Record<string, unknown>;
  processed_at: Date;
}
