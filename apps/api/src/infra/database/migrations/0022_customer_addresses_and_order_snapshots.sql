-- Migration 0022: Customer Address Book and Delivery Address Snapshots
-- Supports multi-address management, single-default enforcement, and frozen delivery snapshots.

-- 1. Customer Addresses table
CREATE TABLE IF NOT EXISTS customer_addresses (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label VARCHAR(32) NOT NULL DEFAULT 'Home',
  recipient_name VARCHAR(255) NOT NULL,
  phone VARCHAR(32) NOT NULL,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  landmark TEXT,
  city VARCHAR(128) NOT NULL,
  state VARCHAR(128) NOT NULL,
  postal_code VARCHAR(32) NOT NULL,
  country VARCHAR(64) NOT NULL DEFAULT 'US',
  latitude NUMERIC(10, 7),
  longitude NUMERIC(10, 7),
  google_place_id VARCHAR(255),
  formatted_address TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_address_label CHECK (label IN ('Home', 'Work', 'Other'))
);

CREATE INDEX IF NOT EXISTS idx_customer_addresses_tenant ON customer_addresses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer ON customer_addresses(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_default_address ON customer_addresses(customer_id) WHERE is_default = TRUE;

-- 2. Add shipping_address JSONB snapshots to checkout sessions and customer orders
ALTER TABLE checkout_sessions
  ADD COLUMN IF NOT EXISTS shipping_address JSONB;

ALTER TABLE customer_orders
  ADD COLUMN IF NOT EXISTS shipping_address JSONB;
