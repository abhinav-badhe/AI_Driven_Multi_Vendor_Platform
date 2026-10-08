-- Migration: 0021_promotions_and_coupons_schema.sql
-- Description: Promotion definitions, coupons, redemptions, checkout/order discount snapshots, and analytics facts

-- 1. Promotions: Authoritative promotional campaigns and coupon rules
CREATE TABLE IF NOT EXISTS promotions (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  merchant_tenant_id VARCHAR(36) REFERENCES tenants(id) ON DELETE CASCADE,
  code VARCHAR(64),
  discount_type VARCHAR(32) NOT NULL,
  discount_value INTEGER NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  scope VARCHAR(32) NOT NULL DEFAULT 'ORDER',
  target_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  min_order_amount INTEGER NOT NULL DEFAULT 0,
  max_discount_amount INTEGER,
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  usage_limit_total INTEGER,
  usage_limit_per_customer INTEGER,
  current_usage_count INTEGER NOT NULL DEFAULT 0,
  first_order_only BOOLEAN NOT NULL DEFAULT FALSE,
  stackable BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_discount_type CHECK (discount_type IN ('PERCENTAGE', 'FIXED_AMOUNT')),
  CONSTRAINT chk_promo_scope CHECK (scope IN ('ORDER', 'PRODUCT', 'CATEGORY')),
  CONSTRAINT chk_promo_status CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
  CONSTRAINT chk_discount_val_pos CHECK (discount_value > 0),
  CONSTRAINT chk_min_order_non_neg CHECK (min_order_amount >= 0),
  CONSTRAINT chk_usage_count_non_neg CHECK (current_usage_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_promo_code ON promotions(code);
CREATE INDEX IF NOT EXISTS idx_promotions_merchant ON promotions(merchant_tenant_id);
CREATE INDEX IF NOT EXISTS idx_promotions_status ON promotions(status);
CREATE INDEX IF NOT EXISTS idx_promotions_dates ON promotions(starts_at, expires_at);

-- 2. Coupon Redemptions: Transactional tracking of coupon claims and usages
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id VARCHAR(36) PRIMARY KEY,
  promotion_id VARCHAR(36) NOT NULL REFERENCES promotions(id) ON DELETE RESTRICT,
  coupon_code VARCHAR(64),
  checkout_session_id VARCHAR(36) NOT NULL,
  customer_order_id VARCHAR(36),
  customer_tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  merchant_tenant_id VARCHAR(36) REFERENCES tenants(id) ON DELETE RESTRICT,
  discount_amount INTEGER NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'RESERVED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_redemption_discount CHECK (discount_amount >= 0),
  CONSTRAINT chk_redemption_status CHECK (status IN ('RESERVED', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT uq_redemption_checkout UNIQUE (checkout_session_id, promotion_id)
);

CREATE INDEX IF NOT EXISTS idx_redemptions_promo ON coupon_redemptions(promotion_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_customer ON coupon_redemptions(customer_tenant_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_order ON coupon_redemptions(customer_order_id);

-- 3. Enhance checkout_sessions, customer_orders, and seller_orders
ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(64);
ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS applied_promotions JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(64);
ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS applied_promotions JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE seller_orders ADD COLUMN IF NOT EXISTS discount_amount INTEGER NOT NULL DEFAULT 0;

-- 4. Analytics promotion facts
CREATE TABLE IF NOT EXISTS analytics_promotion_facts (
  fact_id VARCHAR(64) PRIMARY KEY,
  event_id VARCHAR(64) NOT NULL UNIQUE,
  tenant_id VARCHAR(64) NOT NULL,
  merchant_id VARCHAR(64),
  promotion_id VARCHAR(64) NOT NULL,
  coupon_code VARCHAR(64),
  order_id VARCHAR(64),
  discount_amount NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anl_promo_facts_tenant ON analytics_promotion_facts(tenant_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_anl_promo_facts_promo ON analytics_promotion_facts(promotion_id);
