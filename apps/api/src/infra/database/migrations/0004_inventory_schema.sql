-- Migration 0004: Inventory and Concurrency-Safe Stock Management Schema
-- Author: Phase 4 Architecture Implementation

-- 1. Inventory Items: Authoritative stock truth per merchant listing
-- Enforces: Available = On Hand - Reserved - Non-Sellable >= 0
CREATE TABLE IF NOT EXISTS inventory_items (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  listing_id VARCHAR(36) NOT NULL UNIQUE REFERENCES merchant_listings(id) ON DELETE CASCADE,
  sku_id VARCHAR(36) NOT NULL REFERENCES product_skus(id) ON DELETE CASCADE,
  on_hand_quantity INTEGER NOT NULL DEFAULT 0,
  reserved_quantity INTEGER NOT NULL DEFAULT 0,
  non_sellable_quantity INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_on_hand_non_negative CHECK (on_hand_quantity >= 0),
  CONSTRAINT chk_reserved_non_negative CHECK (reserved_quantity >= 0),
  CONSTRAINT chk_non_sellable_non_negative CHECK (non_sellable_quantity >= 0),
  CONSTRAINT chk_reserved_le_on_hand CHECK (reserved_quantity <= on_hand_quantity),
  CONSTRAINT chk_availability_non_negative CHECK (on_hand_quantity - reserved_quantity - non_sellable_quantity >= 0)
);

CREATE INDEX IF NOT EXISTS idx_inventory_tenant ON inventory_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_listing ON inventory_items(listing_id);
CREATE INDEX IF NOT EXISTS idx_inventory_sku ON inventory_items(sku_id);

-- 2. Inventory Reservations: Concurrency-safe reservation holds with explicit lifecycle
CREATE TABLE IF NOT EXISTS inventory_reservations (
  id VARCHAR(36) PRIMARY KEY,
  inventory_id VARCHAR(36) NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_tenant_id VARCHAR(36) REFERENCES tenants(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  idempotency_key VARCHAR(128),
  expires_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_reservation_quantity_positive CHECK (quantity > 0),
  CONSTRAINT chk_reservation_status CHECK (
    status IN ('ACTIVE', 'RELEASED', 'CONSUMED', 'EXPIRED')
  ),
  CONSTRAINT uq_reservation_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_reservations_inventory ON inventory_reservations(inventory_id);
CREATE INDEX IF NOT EXISTS idx_reservations_tenant ON inventory_reservations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON inventory_reservations(status);
CREATE INDEX IF NOT EXISTS idx_reservations_expires ON inventory_reservations(expires_at);

-- 3. Inventory Movements: Append-only auditable ledger of all stock quantity changes
CREATE TABLE IF NOT EXISTS inventory_movements (
  id VARCHAR(36) PRIMARY KEY,
  inventory_id VARCHAR(36) NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  movement_type VARCHAR(64) NOT NULL,
  quantity_delta INTEGER NOT NULL,
  previous_on_hand INTEGER NOT NULL,
  new_on_hand INTEGER NOT NULL,
  previous_reserved INTEGER NOT NULL,
  new_reserved INTEGER NOT NULL,
  previous_non_sellable INTEGER NOT NULL,
  new_non_sellable INTEGER NOT NULL,
  reference_id VARCHAR(128),
  actor_id VARCHAR(64) NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_movement_type CHECK (
    movement_type IN (
      'INITIAL_STOCK',
      'STOCK_INCREASE',
      'STOCK_DECREASE',
      'RESERVATION_HOLD',
      'RESERVATION_RELEASE',
      'RESERVATION_CONSUME',
      'NON_SELLABLE_ADJUSTMENT',
      'MANUAL_ADJUSTMENT'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_movements_inventory ON inventory_movements(inventory_id);
CREATE INDEX IF NOT EXISTS idx_movements_tenant ON inventory_movements(tenant_id);
CREATE INDEX IF NOT EXISTS idx_movements_created ON inventory_movements(created_at);
