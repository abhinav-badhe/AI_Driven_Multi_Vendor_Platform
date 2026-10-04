-- Migration 0003: Catalog and Marketplace Listings Schema
-- Author: Phase 3 Architecture Implementation

-- Categories: Master hierarchical classification of canonical products
CREATE TABLE IF NOT EXISTS categories (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  parent_id VARCHAR(36) REFERENCES categories(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_categories_slug ON categories(slug);

-- Products: Canonical, seller-independent product definition
CREATE TABLE IF NOT EXISTS products (
  id VARCHAR(36) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  brand VARCHAR(255),
  category_id VARCHAR(36) REFERENCES categories(id) ON DELETE RESTRICT,
  status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_product_status CHECK (
    status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED')
  )
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);

-- Product SKUs: Specific sellable variants (size, color, etc.) of a canonical product
CREATE TABLE IF NOT EXISTS product_skus (
  id VARCHAR(36) PRIMARY KEY,
  product_id VARCHAR(36) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku_code VARCHAR(100) NOT NULL UNIQUE,
  barcode VARCHAR(100),
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_sku_status CHECK (
    status IN ('DRAFT', 'ACTIVE', 'INACTIVE')
  )
);

CREATE INDEX IF NOT EXISTS idx_skus_product ON product_skus(product_id);
CREATE INDEX IF NOT EXISTS idx_skus_code ON product_skus(sku_code);
CREATE INDEX IF NOT EXISTS idx_skus_status ON product_skus(status);

-- Merchant Listings: Merchant-specific offer for a canonical SKU
-- Multiple merchants can list the same SKU. Price is owned by the merchant listing.
-- Inventory is strictly reserved for Phase 4 (no stock/quantity columns here).
CREATE TABLE IF NOT EXISTS merchant_listings (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku_id VARCHAR(36) NOT NULL REFERENCES product_skus(id) ON DELETE CASCADE,
  price_amount INTEGER NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  compare_at_price INTEGER,
  status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_listing_status CHECK (
    status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'SUSPENDED')
  ),
  CONSTRAINT chk_listing_price_positive CHECK (price_amount >= 0),
  CONSTRAINT uq_merchant_sku UNIQUE (tenant_id, sku_id)
);

CREATE INDEX IF NOT EXISTS idx_listings_tenant ON merchant_listings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_listings_sku ON merchant_listings(sku_id);
CREATE INDEX IF NOT EXISTS idx_listings_status ON merchant_listings(status);
