-- Migration 0023: Customer Product Reviews & Ratings with Moderation
-- Extends product_reviews with customer ownership, order item tracking, verified purchase flag,
-- moderation lifecycle (PENDING, APPROVED, REJECTED), and review titles.

ALTER TABLE product_reviews
  ADD COLUMN IF NOT EXISTS customer_id VARCHAR(36) REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(36) REFERENCES tenants(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS order_id VARCHAR(36) REFERENCES customer_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS order_item_id VARCHAR(36) REFERENCES order_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS title VARCHAR(255),
  ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN IF NOT EXISTS verified_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS moderated_by VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS moderation_note TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Preserve visibility of legacy / seeded reviews without explicit status
UPDATE product_reviews
SET status = 'APPROVED'
WHERE status IS NULL;

-- One review per customer per product constraint
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_product_review
  ON product_reviews(customer_id, product_id)
  WHERE customer_id IS NOT NULL;

-- Query optimization indexes
CREATE INDEX IF NOT EXISTS idx_reviews_customer ON product_reviews(customer_id);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON product_reviews(status);
CREATE INDEX IF NOT EXISTS idx_reviews_product_status ON product_reviews(product_id, status);
CREATE INDEX IF NOT EXISTS idx_reviews_order_item ON product_reviews(order_item_id);
