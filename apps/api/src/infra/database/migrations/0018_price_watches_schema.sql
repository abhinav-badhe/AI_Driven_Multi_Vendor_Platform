-- Migration 0018: Product price watches for price-drop alerts
-- Records what verified customers viewed (and at what price) so the
-- price-drop automation can notify them when watched products get cheaper.

CREATE TABLE IF NOT EXISTS product_price_watches (
  id VARCHAR(36) PRIMARY KEY,
  customer_tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id VARCHAR(36) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  last_seen_price INTEGER,
  last_seen_currency VARCHAR(3),
  last_alerted_price INTEGER,
  alert_count INTEGER NOT NULL DEFAULT 0,
  unsubscribed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_price_watch_customer_product UNIQUE (customer_tenant_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_price_watches_product ON product_price_watches(product_id);
CREATE INDEX IF NOT EXISTS idx_price_watches_customer ON product_price_watches(customer_tenant_id);
