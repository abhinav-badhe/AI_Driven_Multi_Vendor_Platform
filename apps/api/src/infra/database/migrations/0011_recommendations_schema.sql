-- Migration: 0011_recommendations_schema.sql
-- Description: Derived recommendation storage, candidate ranking snapshots, and rebuild audit logs.
-- Phase: 12 (Recommendations)
-- Invariant: Recommendation data is strictly derived and read-only with respect to commerce truth.
-- It NEVER becomes the transactional source of truth for identity, price, inventory, or orders.

-- 1. Derived Recommendations Store
CREATE TABLE IF NOT EXISTS derived_recommendations (
  id VARCHAR(64) PRIMARY KEY,
  scope_key VARCHAR(255) NOT NULL UNIQUE,
  tenant_id VARCHAR(64) NOT NULL,
  customer_id VARCHAR(64),
  recommendation_type VARCHAR(32) NOT NULL,
  source_product_id VARCHAR(64),
  recommended_product_id VARCHAR(64) NOT NULL,
  rank_position INT NOT NULL,
  score NUMERIC(10,4) NOT NULL DEFAULT 0.0000,
  reason_code VARCHAR(64) NOT NULL,
  explanation TEXT NOT NULL,
  derived_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rec_tenant_type ON derived_recommendations (tenant_id, recommendation_type);
CREATE INDEX IF NOT EXISTS idx_rec_tenant_customer ON derived_recommendations (tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_rec_tenant_source_product ON derived_recommendations (tenant_id, source_product_id);
CREATE INDEX IF NOT EXISTS idx_rec_recommended_product ON derived_recommendations (recommended_product_id);
CREATE INDEX IF NOT EXISTS idx_rec_scope_key ON derived_recommendations (scope_key);

-- 2. Recommendation Rebuild Audit Log
CREATE TABLE IF NOT EXISTS recommendation_rebuild_audit (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  rebuilt_by_actor_id VARCHAR(64) NOT NULL,
  recommendations_generated INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'COMPLETED',
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rec_rebuild_tenant ON recommendation_rebuild_audit (tenant_id, started_at);
