-- Migration 0025: Customer Back-in-Stock Alerts and Subscriptions
-- Author: Customer Experience & Inventory Notifications

CREATE TABLE IF NOT EXISTS back_in_stock_subscriptions (
  id VARCHAR(36) PRIMARY KEY,
  customer_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id VARCHAR(36) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku_id VARCHAR(36) REFERENCES product_skus(id) ON DELETE SET NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_customer_back_in_stock UNIQUE (customer_id, product_id),
  CONSTRAINT chk_back_in_stock_status CHECK (status IN ('ACTIVE', 'NOTIFIED', 'CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_back_in_stock_customer_tenant ON back_in_stock_subscriptions(customer_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_back_in_stock_product_status ON back_in_stock_subscriptions(product_id, status);
CREATE INDEX IF NOT EXISTS idx_back_in_stock_sku_status ON back_in_stock_subscriptions(sku_id, status) WHERE sku_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_back_in_stock_tenant_status ON back_in_stock_subscriptions(tenant_id, status);
