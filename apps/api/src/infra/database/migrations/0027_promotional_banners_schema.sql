-- Migration: 0027_promotional_banners_schema.sql
-- Description: Promotional hero posters & banners configuration for storefront

CREATE TABLE IF NOT EXISTS promotional_banners (
  id VARCHAR(36) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  subtitle VARCHAR(255),
  badge_text VARCHAR(64),
  image_url TEXT NOT NULL,
  target_url VARCHAR(255) DEFAULT '/search',
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_promotional_banners_active ON promotional_banners(is_active, display_order);

-- Seed initial default sale banner with a vibrant e-commerce promotional poster
INSERT INTO promotional_banners (id, title, subtitle, badge_text, image_url, target_url, display_order, is_active)
VALUES (
  'banner-hero-summer-01',
  'FESTIVE MEGA SALE',
  'Up to 40% OFF on Top Laptops, Audio Gear & Smart Accessories',
  'LIMITED TIME OFFER',
  'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?auto=format&fit=crop&w=1600&q=80',
  '/search',
  1,
  TRUE
) ON CONFLICT (id) DO NOTHING;
