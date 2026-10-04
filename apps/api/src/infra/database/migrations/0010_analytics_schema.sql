-- Migration: 0010_analytics_schema.sql
-- Description: Analytics fact tables, daily metrics aggregates, quarantine records, and rebuild audit logs.
-- Phase: 11 (Analytics)

-- 1. Analytics Order Facts (Sales & Orders Read Model)
CREATE TABLE IF NOT EXISTS analytics_order_facts (
  fact_id VARCHAR(64) PRIMARY KEY,
  event_id VARCHAR(64) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  order_id VARCHAR(64) NOT NULL,
  seller_order_id VARCHAR(64),
  merchant_id VARCHAR(64),
  customer_id VARCHAR(64),
  product_id VARCHAR(64),
  sku VARCHAR(64),
  listing_id VARCHAR(64),
  quantity INT NOT NULL DEFAULT 1,
  unit_price NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
  total_amount NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  order_status VARCHAR(32) NOT NULL,
  ordered_at TIMESTAMPTZ NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_analytics_order_fact UNIQUE (event_id, order_id, product_id, merchant_id)
);

CREATE INDEX IF NOT EXISTS idx_anl_order_facts_tenant_occurred ON analytics_order_facts (tenant_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_anl_order_facts_tenant_merchant ON analytics_order_facts (tenant_id, merchant_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_anl_order_facts_tenant_product ON analytics_order_facts (tenant_id, product_id);
CREATE INDEX IF NOT EXISTS idx_anl_order_facts_order_id ON analytics_order_facts (order_id);
CREATE INDEX IF NOT EXISTS idx_anl_order_facts_event_id ON analytics_order_facts (event_id);

-- 2. Analytics Payment Facts (Payment Outcomes & Refunds)
CREATE TABLE IF NOT EXISTS analytics_payment_facts (
  fact_id VARCHAR(64) PRIMARY KEY,
  event_id VARCHAR(64) NOT NULL UNIQUE,
  tenant_id VARCHAR(64) NOT NULL,
  payment_intent_id VARCHAR(64) NOT NULL,
  order_id VARCHAR(64),
  merchant_id VARCHAR(64),
  amount NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(32) NOT NULL,
  failure_reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anl_payment_facts_tenant_occurred ON analytics_payment_facts (tenant_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_anl_payment_facts_tenant_status ON analytics_payment_facts (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_anl_payment_facts_intent_id ON analytics_payment_facts (payment_intent_id);

-- 3. Analytics Fulfillment Facts (Shipments & Returns)
CREATE TABLE IF NOT EXISTS analytics_fulfillment_facts (
  fact_id VARCHAR(64) PRIMARY KEY,
  event_id VARCHAR(64) NOT NULL UNIQUE,
  tenant_id VARCHAR(64) NOT NULL,
  shipment_id VARCHAR(64),
  return_id VARCHAR(64),
  seller_order_id VARCHAR(64),
  merchant_id VARCHAR(64),
  fulfillment_status VARCHAR(32) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anl_fulfillment_facts_tenant_occurred ON analytics_fulfillment_facts (tenant_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_anl_fulfillment_facts_tenant_status ON analytics_fulfillment_facts (tenant_id, fulfillment_status);

-- 4. Analytics Settlement Facts (Financial Performance)
CREATE TABLE IF NOT EXISTS analytics_settlement_facts (
  fact_id VARCHAR(64) PRIMARY KEY,
  event_id VARCHAR(64) NOT NULL UNIQUE,
  tenant_id VARCHAR(64) NOT NULL,
  settlement_id VARCHAR(64) NOT NULL,
  merchant_id VARCHAR(64) NOT NULL,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  gross_amount NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
  commission_amount NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
  net_payout_amount NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(32) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anl_settlement_facts_tenant_merchant ON analytics_settlement_facts (tenant_id, merchant_id, occurred_at);

-- 5. Analytics Catalog & Marketplace Snapshots (Product / Listing Dimensions)
CREATE TABLE IF NOT EXISTS analytics_catalog_facts (
  fact_id VARCHAR(64) PRIMARY KEY,
  event_id VARCHAR(64) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  product_id VARCHAR(64),
  listing_id VARCHAR(64),
  merchant_id VARCHAR(64),
  category VARCHAR(128),
  title VARCHAR(255),
  status VARCHAR(32) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_anl_catalog_fact UNIQUE (event_id, entity_type, product_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_anl_catalog_facts_tenant_entity ON analytics_catalog_facts (tenant_id, entity_type, product_id);

-- 6. Analytics Daily Metrics Aggregates (Aggregated Read Model)
CREATE TABLE IF NOT EXISTS analytics_daily_metrics (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  merchant_id VARCHAR(64) NOT NULL DEFAULT 'ALL',
  metric_date VARCHAR(10) NOT NULL,
  granularity VARCHAR(16) NOT NULL DEFAULT 'DAY',
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  total_orders INT NOT NULL DEFAULT 0,
  gross_sales NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
  net_sales NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
  refund_amount NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
  units_sold INT NOT NULL DEFAULT 0,
  payment_success_count INT NOT NULL DEFAULT 0,
  payment_fail_count INT NOT NULL DEFAULT 0,
  shipment_count INT NOT NULL DEFAULT 0,
  return_count INT NOT NULL DEFAULT 0,
  settlement_gross NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
  settlement_net NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_analytics_metric UNIQUE (tenant_id, merchant_id, metric_date, granularity, currency)
);

CREATE INDEX IF NOT EXISTS idx_anl_metrics_lookup ON analytics_daily_metrics (tenant_id, merchant_id, metric_date, granularity, currency);

-- 7. Analytics Data Quality Quarantine Log
CREATE TABLE IF NOT EXISTS analytics_quarantine_records (
  id VARCHAR(64) PRIMARY KEY,
  event_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  violation_reason TEXT NOT NULL,
  payload_preview TEXT,
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anl_quarantine_tenant ON analytics_quarantine_records (tenant_id, quarantined_at);

-- 8. Analytics Administrative Rebuild Audit
CREATE TABLE IF NOT EXISTS analytics_rebuild_audit (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  rebuilt_by_actor_id VARCHAR(64) NOT NULL,
  source_event_count INT NOT NULL DEFAULT 0,
  facts_rebuilt INT NOT NULL DEFAULT 0,
  aggregates_rebuilt INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'COMPLETED',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
