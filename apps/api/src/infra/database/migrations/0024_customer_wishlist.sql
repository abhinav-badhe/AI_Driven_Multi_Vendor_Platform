-- Migration 0024: Customer Wishlist and Save for Later
-- Author: Customer Experience & Catalog Preferences

CREATE TABLE IF NOT EXISTS wishlist_items (
  id VARCHAR(36) PRIMARY KEY,
  customer_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id VARCHAR(36) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku_id VARCHAR(36) REFERENCES product_skus(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_customer_wishlist_product UNIQUE (customer_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_wishlist_customer ON wishlist_items(customer_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_tenant ON wishlist_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_product ON wishlist_items(product_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_customer_product ON wishlist_items(customer_id, product_id);
