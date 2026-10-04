-- Migration 0002: Merchant Bounded Context Schema
-- Author: Phase 2 Architecture Implementation

-- Merchant Profiles: Business profile, onboarding and verification state
CREATE TABLE IF NOT EXISTS merchant_profiles (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  business_name VARCHAR(255) NOT NULL,
  legal_name VARCHAR(255) NOT NULL,
  contact_email VARCHAR(255) NOT NULL,
  verification_status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  rejection_reason TEXT,
  verified_at TIMESTAMPTZ,
  verified_by VARCHAR(36) REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_merchant_status CHECK (
    verification_status IN ('DRAFT', 'SUBMITTED', 'VERIFIED', 'REJECTED', 'SUSPENDED')
  )
);

CREATE INDEX IF NOT EXISTS idx_merchant_profiles_tenant ON merchant_profiles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_merchant_profiles_status ON merchant_profiles(verification_status);
