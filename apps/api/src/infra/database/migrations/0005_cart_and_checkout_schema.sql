-- Migration 0005: Cart and Multi-Vendor Checkout Orchestration Schema
-- Author: Phase 5 Architecture Implementation

-- 1. Carts: Active shopping carts owned strictly by customer tenant
CREATE TABLE IF NOT EXISTS carts (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_cart_status CHECK (status IN ('ACTIVE', 'ABANDONED', 'CONVERTED'))
);

CREATE INDEX IF NOT EXISTS idx_carts_tenant ON carts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_carts_status ON carts(status);

-- 2. Cart Items: Multi-vendor items referencing existing canonical SKU & Merchant Listing
CREATE TABLE IF NOT EXISTS cart_items (
  id VARCHAR(36) PRIMARY KEY,
  cart_id VARCHAR(36) NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  listing_id VARCHAR(36) NOT NULL REFERENCES merchant_listings(id) ON DELETE RESTRICT,
  sku_id VARCHAR(36) NOT NULL REFERENCES product_skus(id) ON DELETE RESTRICT,
  merchant_tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_cart_item_quantity_positive CHECK (quantity > 0),
  CONSTRAINT uq_cart_item_listing UNIQUE (cart_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_cart_items_cart ON cart_items(cart_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_listing ON cart_items(listing_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_merchant ON cart_items(merchant_tenant_id);

-- 3. Checkout Sessions: Orchestration state machine for controlled checkout attempts
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id VARCHAR(36) PRIMARY KEY,
  cart_id VARCHAR(36) NOT NULL REFERENCES carts(id) ON DELETE RESTRICT,
  customer_tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
  currency VARCHAR(3) NOT NULL,
  subtotal_amount INTEGER NOT NULL DEFAULT 0,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  shipping_amount INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  total_amount INTEGER NOT NULL DEFAULT 0,
  idempotency_key VARCHAR(128),
  expires_at TIMESTAMPTZ NOT NULL,
  reserved_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_checkout_status CHECK (
    status IN ('OPEN', 'VALIDATING', 'RESERVED', 'READY', 'FAILED', 'EXPIRED', 'CANCELLED')
  ),
  CONSTRAINT chk_subtotal_non_negative CHECK (subtotal_amount >= 0),
  CONSTRAINT chk_total_non_negative CHECK (total_amount >= 0),
  CONSTRAINT uq_checkout_idempotency UNIQUE (customer_tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_checkout_customer ON checkout_sessions(customer_tenant_id);
CREATE INDEX IF NOT EXISTS idx_checkout_status ON checkout_sessions(status);
CREATE INDEX IF NOT EXISTS idx_checkout_expires ON checkout_sessions(expires_at);

-- 4. Checkout Items: Immutable financial & reservation snapshot per line item
CREATE TABLE IF NOT EXISTS checkout_items (
  id VARCHAR(36) PRIMARY KEY,
  checkout_session_id VARCHAR(36) NOT NULL REFERENCES checkout_sessions(id) ON DELETE CASCADE,
  listing_id VARCHAR(36) NOT NULL REFERENCES merchant_listings(id) ON DELETE RESTRICT,
  sku_id VARCHAR(36) NOT NULL REFERENCES product_skus(id) ON DELETE RESTRICT,
  merchant_tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL,
  unit_price_amount INTEGER NOT NULL,
  line_total_amount INTEGER NOT NULL,
  currency VARCHAR(3) NOT NULL,
  inventory_reservation_id VARCHAR(36),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_checkout_item_qty_positive CHECK (quantity > 0),
  CONSTRAINT chk_checkout_item_price_non_neg CHECK (unit_price_amount >= 0),
  CONSTRAINT chk_checkout_item_total_non_neg CHECK (line_total_amount >= 0),
  CONSTRAINT uq_checkout_item_listing UNIQUE (checkout_session_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_checkout_items_session ON checkout_items(checkout_session_id);
CREATE INDEX IF NOT EXISTS idx_checkout_items_reservation ON checkout_items(inventory_reservation_id);
