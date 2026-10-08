-- Migration: 0020_carrier_shipment_enhancements.sql
-- Description: Add carrier_shipment_id and label_url to shipments table and carrier_shipment_operations for durable carrier idempotency

ALTER TABLE shipments ADD COLUMN IF NOT EXISTS carrier_shipment_id VARCHAR(128);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS label_url TEXT;

CREATE INDEX IF NOT EXISTS idx_shipments_carrier_shipment_id ON shipments(carrier_shipment_id);

CREATE TABLE IF NOT EXISTS carrier_shipment_operations (
  idempotency_key VARCHAR(255) PRIMARY KEY,
  seller_order_id VARCHAR(36) NOT NULL REFERENCES seller_orders(id) ON DELETE RESTRICT,
  seller_tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  carrier VARCHAR(64) NOT NULL,
  carrier_shipment_id VARCHAR(128),
  tracking_number VARCHAR(128),
  tracking_url TEXT,
  label_url TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'IN_PROGRESS',
  claim_token VARCHAR(64),
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_carrier_ops_order ON carrier_shipment_operations(seller_order_id);
CREATE INDEX IF NOT EXISTS idx_carrier_ops_carrier_shipment ON carrier_shipment_operations(carrier_shipment_id);
