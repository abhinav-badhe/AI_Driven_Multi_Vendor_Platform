-- Migration: 0015_search_projections_schema.sql
-- Description: Persistent, shared search projection tables for Phase 9 Search bounded context

-- 1. Search projection state tracking active generation for atomic, zero-downtime rebuilds
CREATE TABLE IF NOT EXISTS search_projection_state (
  id VARCHAR(32) PRIMARY KEY,
  active_generation INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Search Product Projections (Derived Read Model)
CREATE TABLE IF NOT EXISTS search_product_projections (
  id VARCHAR(36) NOT NULL,
  generation INT NOT NULL DEFAULT 1,
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  description TEXT,
  brand VARCHAR(255),
  category_id VARCHAR(36),
  category_name VARCHAR(255),
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  min_price INT NOT NULL DEFAULT 0,
  max_price INT NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  has_in_stock_offer BOOLEAN NOT NULL DEFAULT FALSE,
  total_offers_count INT NOT NULL DEFAULT 0,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_version BIGINT NOT NULL DEFAULT 0,
  projection_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, generation),
  CONSTRAINT chk_search_product_status CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'))
);

CREATE INDEX IF NOT EXISTS idx_search_prod_gen ON search_product_projections(generation);
CREATE INDEX IF NOT EXISTS idx_search_prod_gen_status ON search_product_projections(generation, status);
CREATE INDEX IF NOT EXISTS idx_search_prod_gen_cat ON search_product_projections(generation, category_id);
CREATE INDEX IF NOT EXISTS idx_search_prod_gen_brand ON search_product_projections(generation, brand);
CREATE INDEX IF NOT EXISTS idx_search_prod_gen_price ON search_product_projections(generation, min_price, max_price);
CREATE INDEX IF NOT EXISTS idx_search_prod_gen_stock ON search_product_projections(generation, has_in_stock_offer);

-- 3. Search Seller Offers (Derived Merchant/SKU discovery offers)
CREATE TABLE IF NOT EXISTS search_seller_offers (
  listing_id VARCHAR(36) NOT NULL,
  generation INT NOT NULL DEFAULT 1,
  product_id VARCHAR(36) NOT NULL,
  merchant_id VARCHAR(36) NOT NULL,
  merchant_name VARCHAR(255),
  sku_id VARCHAR(36) NOT NULL,
  sku_code VARCHAR(64) NOT NULL,
  price_amount INT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  compare_at_price INT,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  in_stock BOOLEAN NOT NULL DEFAULT FALSE,
  available_quantity INT NOT NULL DEFAULT 0,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_version BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (listing_id, generation),
  CONSTRAINT chk_search_offer_status CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'SUSPENDED'))
);

CREATE INDEX IF NOT EXISTS idx_search_offer_gen_prod ON search_seller_offers(generation, product_id);
CREATE INDEX IF NOT EXISTS idx_search_offer_gen_merch ON search_seller_offers(generation, merchant_id);
CREATE INDEX IF NOT EXISTS idx_search_offer_gen_stock ON search_seller_offers(generation, in_stock);
