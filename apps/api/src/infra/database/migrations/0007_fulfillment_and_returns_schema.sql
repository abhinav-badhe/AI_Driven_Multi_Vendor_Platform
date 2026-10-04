-- Migration: 0007_fulfillment_and_returns_schema.sql
-- Description: Fulfillment (Shipments, Shipment Items) and Returns (Returns, Return Items)

-- 1. Shipments: Seller-order fulfillment records
CREATE TABLE IF NOT EXISTS shipments (
  id VARCHAR(36) PRIMARY KEY,
  seller_order_id VARCHAR(36) NOT NULL REFERENCES seller_orders(id) ON DELETE RESTRICT,
  customer_order_id VARCHAR(36) NOT NULL REFERENCES customer_orders(id) ON DELETE RESTRICT,
  seller_tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  carrier VARCHAR(64),
  tracking_number VARCHAR(128),
  tracking_url TEXT,
  shipped_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  estimated_delivery_at TIMESTAMPTZ,
  idempotency_key VARCHAR(128),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_shipment_status CHECK (
    status IN ('PENDING', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'FAILED', 'RETURNED')
  ),
  CONSTRAINT uq_shipment_idempotency UNIQUE (seller_tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_shipments_seller_order ON shipments(seller_order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_customer_order ON shipments(customer_order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_seller_tenant ON shipments(seller_tenant_id);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
CREATE INDEX IF NOT EXISTS idx_shipments_tracking ON shipments(carrier, tracking_number);

-- 2. Shipment Items: Quantities of order items assigned to this shipment
CREATE TABLE IF NOT EXISTS shipment_items (
  id VARCHAR(36) PRIMARY KEY,
  shipment_id VARCHAR(36) NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  order_item_id VARCHAR(36) NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_shipment_item_qty CHECK (quantity > 0),
  CONSTRAINT uq_shipment_order_item UNIQUE (shipment_id, order_item_id)
);

CREATE INDEX IF NOT EXISTS idx_shipment_items_shipment ON shipment_items(shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_items_order_item ON shipment_items(order_item_id);

-- 3. Returns: Customer return requests against orders/seller orders
CREATE TABLE IF NOT EXISTS returns (
  id VARCHAR(36) PRIMARY KEY,
  customer_tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  customer_order_id VARCHAR(36) NOT NULL REFERENCES customer_orders(id) ON DELETE RESTRICT,
  seller_order_id VARCHAR(36) NOT NULL REFERENCES seller_orders(id) ON DELETE RESTRICT,
  seller_tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  status VARCHAR(32) NOT NULL DEFAULT 'REQUESTED',
  reason TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  refund_id VARCHAR(36) REFERENCES payment_refunds(id) ON DELETE SET NULL,
  idempotency_key VARCHAR(128),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_return_status CHECK (
    status IN ('REQUESTED', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'COMPLETED', 'REJECTED', 'CANCELLED')
  ),
  CONSTRAINT uq_return_idempotency UNIQUE (customer_tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_returns_customer_tenant ON returns(customer_tenant_id);
CREATE INDEX IF NOT EXISTS idx_returns_seller_tenant ON returns(seller_tenant_id);
CREATE INDEX IF NOT EXISTS idx_returns_customer_order ON returns(customer_order_id);
CREATE INDEX IF NOT EXISTS idx_returns_seller_order ON returns(seller_order_id);
CREATE INDEX IF NOT EXISTS idx_returns_status ON returns(status);

-- 4. Return Items: Line items requested for return
CREATE TABLE IF NOT EXISTS return_items (
  id VARCHAR(36) PRIMARY KEY,
  return_id VARCHAR(36) NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  order_item_id VARCHAR(36) NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_return_item_qty CHECK (quantity > 0),
  CONSTRAINT uq_return_order_item UNIQUE (return_id, order_item_id)
);

CREATE INDEX IF NOT EXISTS idx_return_items_return ON return_items(return_id);
CREATE INDEX IF NOT EXISTS idx_return_items_order_item ON return_items(order_item_id);

-- 5. Carrier Webhook Events: Replay protection and at-least-once deduplication ledger
CREATE TABLE IF NOT EXISTS carrier_webhook_events (
  id VARCHAR(36) PRIMARY KEY,
  carrier VARCHAR(64) NOT NULL,
  provider_event_id VARCHAR(255) NOT NULL,
  tracking_number VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_carrier_webhook_event UNIQUE (carrier, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_carrier_webhook_events_carrier ON carrier_webhook_events(carrier, provider_event_id);

-- 6. Durable Inventory Movement Reference Uniqueness for Idempotent Restocking
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_movement_type_reference ON inventory_movements(movement_type, reference_id) WHERE reference_id IS NOT NULL;

-- 7. Durable Payment Refund Idempotency Uniqueness (Cross-Intent Protection)
CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_global_idempotency ON payment_refunds(idempotency_key) WHERE idempotency_key IS NOT NULL;

