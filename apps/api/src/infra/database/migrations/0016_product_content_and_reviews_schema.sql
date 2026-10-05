-- Migration 0016: Rich product content (images, ratings, attributes) + product reviews
-- Supports seeding catalog data with merchandising content (thumbnails, galleries,
-- ratings, review bodies, specifications) without disturbing transactional tables.

-- 1. Product enrichment columns (display content owned authoritatively by Catalog)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS thumbnail_url TEXT,
  ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS rating NUMERIC(3, 2),
  ADD COLUMN IF NOT EXISTS review_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attributes JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 2. Product reviews (customer-authored review bodies for a canonical product)
CREATE TABLE IF NOT EXISTS product_reviews (
  id VARCHAR(36) PRIMARY KEY,
  product_id VARCHAR(36) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL,
  comment TEXT,
  reviewer_name VARCHAR(255),
  reviewer_email VARCHAR(255),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_review_rating CHECK (rating >= 1 AND rating <= 5)
);

CREATE INDEX IF NOT EXISTS idx_reviews_product ON product_reviews(product_id);
