-- Migration: 0006_orders_and_payments_schema.sql
-- Description: Orders (Customer & Seller Orders, Snapshots) and Payment (Intents, Attempts, Webhook Deduplication, Refunds)

-- 1. Customer Orders: Top-level authoritative customer purchase contracts
CREATE TABLE IF NOT EXISTS customer_orders (
  id VARCHAR(36) PRIMARY KEY,
  customer_tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  checkout_session_id VARCHAR(36) NOT NULL UNIQUE,
  payment_intent_id VARCHAR(36),
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING_PAYMENT',
  currency VARCHAR(3) NOT NULL,
  subtotal_amount INTEGER NOT NULL,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  shipping_amount INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  total_amount INTEGER NOT NULL,
  idempotency_key VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_customer_order_status CHECK (
    status IN ('PENDING_PAYMENT', 'PAID', 'PROCESSING', 'COMPLETED', 'CANCELLED')
  ),
  CONSTRAINT chk_customer_order_subtotal CHECK (subtotal_amount >= 0),
  CONSTRAINT chk_customer_order_total CHECK (total_amount >= 0),
  CONSTRAINT uq_customer_order_idempotency UNIQUE (customer_tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_customer_orders_tenant ON customer_orders(customer_tenant_id);
CREATE INDEX IF NOT EXISTS idx_customer_orders_status ON customer_orders(status);
CREATE INDEX IF NOT EXISTS idx_customer_orders_checkout ON customer_orders(checkout_session_id);
CREATE INDEX IF NOT EXISTS idx_customer_orders_payment ON customer_orders(payment_intent_id);

-- 2. Seller Orders: Merchant-specific sub-orders grouped by seller tenant
CREATE TABLE IF NOT EXISTS seller_orders (
  id VARCHAR(36) PRIMARY KEY,
  customer_order_id VARCHAR(36) NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
  seller_tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING_PAYMENT',
  currency VARCHAR(3) NOT NULL,
  subtotal_amount INTEGER NOT NULL,
  shipping_amount INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  total_amount INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_seller_order_status CHECK (
    status IN ('PENDING_PAYMENT', 'PAID', 'PROCESSING', 'COMPLETED', 'CANCELLED')
  ),
  CONSTRAINT chk_seller_order_subtotal CHECK (subtotal_amount >= 0),
  CONSTRAINT chk_seller_order_total CHECK (total_amount >= 0),
  CONSTRAINT uq_customer_seller_order UNIQUE (customer_order_id, seller_tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_seller_orders_seller ON seller_orders(seller_tenant_id);
CREATE INDEX IF NOT EXISTS idx_seller_orders_customer_order ON seller_orders(customer_order_id);
CREATE INDEX IF NOT EXISTS idx_seller_orders_status ON seller_orders(status);

-- 3. Order Items: Immutable historical snapshots per line item
CREATE TABLE IF NOT EXISTS order_items (
  id VARCHAR(36) PRIMARY KEY,
  seller_order_id VARCHAR(36) NOT NULL REFERENCES seller_orders(id) ON DELETE CASCADE,
  customer_order_id VARCHAR(36) NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
  listing_id VARCHAR(36) NOT NULL REFERENCES merchant_listings(id) ON DELETE RESTRICT,
  sku_id VARCHAR(36) NOT NULL REFERENCES product_skus(id) ON DELETE RESTRICT,
  product_id VARCHAR(36) NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  merchant_tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  product_name VARCHAR(255) NOT NULL,
  sku_code VARCHAR(100) NOT NULL,
  variant_info JSONB NOT NULL DEFAULT '{}'::jsonb,
  quantity INTEGER NOT NULL,
  unit_price_amount INTEGER NOT NULL,
  line_total_amount INTEGER NOT NULL,
  currency VARCHAR(3) NOT NULL,
  inventory_reservation_id VARCHAR(36),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_order_item_qty CHECK (quantity > 0),
  CONSTRAINT chk_order_item_price CHECK (unit_price_amount >= 0),
  CONSTRAINT chk_order_item_total CHECK (line_total_amount >= 0),
  CONSTRAINT uq_seller_order_listing UNIQUE (seller_order_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_order_items_seller_order ON order_items(seller_order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_customer_order ON order_items(customer_order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_merchant ON order_items(merchant_tenant_id);

-- 4. Payment Intents: Domain-level payment lifecycle representing customer obligation
CREATE TABLE IF NOT EXISTS payment_intents (
  id VARCHAR(36) PRIMARY KEY,
  customer_tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  checkout_session_id VARCHAR(36) NOT NULL,
  order_id VARCHAR(36),
  amount INTEGER NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'CREATED',
  provider VARCHAR(64) NOT NULL,
  client_secret VARCHAR(255) NOT NULL,
  idempotency_key VARCHAR(128),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_payment_intent_status CHECK (
    status IN ('CREATED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REQUIRES_PAYMENT_METHOD')
  ),
  CONSTRAINT chk_payment_intent_amount CHECK (amount > 0),
  CONSTRAINT uq_payment_intent_idempotency UNIQUE (customer_tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_payment_intents_customer ON payment_intents(customer_tenant_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_checkout ON payment_intents(checkout_session_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_order ON payment_intents(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_status ON payment_intents(status);

-- 5. Payment Attempts: Distinct provider transaction execution attempts
CREATE TABLE IF NOT EXISTS payment_attempts (
  id VARCHAR(36) PRIMARY KEY,
  payment_intent_id VARCHAR(36) NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
  provider VARCHAR(64) NOT NULL,
  provider_transaction_id VARCHAR(255) NOT NULL,
  amount INTEGER NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'INITIATED',
  failure_code VARCHAR(64),
  failure_message TEXT,
  provider_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_payment_attempt_status CHECK (
    status IN ('INITIATED', 'PROCESSING', 'SUCCEEDED', 'FAILED')
  ),
  CONSTRAINT chk_payment_attempt_amount CHECK (amount > 0),
  CONSTRAINT uq_payment_attempt_idempotency UNIQUE (payment_intent_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_intent ON payment_attempts(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_status ON payment_attempts(status);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_txn ON payment_attempts(provider_transaction_id);

-- 6. Payment Webhook Events: Replay protection and at-least-once deduplication ledger
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id VARCHAR(36) PRIMARY KEY,
  provider VARCHAR(64) NOT NULL,
  provider_event_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(32) NOT NULL DEFAULT 'PROCESSED',
  CONSTRAINT chk_webhook_status CHECK (status IN ('PROCESSED', 'FAILED', 'IGNORED')),
  CONSTRAINT uq_webhook_provider_event UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_provider ON payment_webhook_events(provider, provider_event_id);

-- 7. Payment Refunds: Phase 6 refund foundation for post-payment failure or customer returns
CREATE TABLE IF NOT EXISTS payment_refunds (
  id VARCHAR(36) PRIMARY KEY,
  payment_intent_id VARCHAR(36) NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
  payment_attempt_id VARCHAR(36) REFERENCES payment_attempts(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  provider_refund_id VARCHAR(255),
  reason TEXT,
  idempotency_key VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_refund_status CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
  CONSTRAINT chk_refund_amount CHECK (amount > 0),
  CONSTRAINT uq_refund_idempotency UNIQUE (payment_intent_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_refunds_intent ON payment_refunds(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_refunds_status ON payment_refunds(status);
