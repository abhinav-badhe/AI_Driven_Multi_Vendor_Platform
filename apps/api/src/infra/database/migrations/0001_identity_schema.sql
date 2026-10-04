-- Migration 0001: Identity & Access Baseline Schema
-- Author: Phase 2 Architecture Implementation

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Tenants: Security and business isolation boundary
CREATE TABLE IF NOT EXISTS tenants (
  id VARCHAR(36) PRIMARY KEY,
  type VARCHAR(32) NOT NULL,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_tenant_type CHECK (type IN ('PLATFORM', 'MERCHANT', 'CUSTOMER')),
  CONSTRAINT chk_tenant_status CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DEACTIVATED'))
);

-- Users: Authentication credentials and actor identity
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_user_status CHECK (status IN ('ACTIVE', 'LOCKED', 'DEACTIVATED'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Tenant Memberships: Associates users to tenant boundaries with explicit RBAC roles
CREATE TABLE IF NOT EXISTS tenant_memberships (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_tenant_user UNIQUE (tenant_id, user_id),
  CONSTRAINT chk_membership_role CHECK (role IN ('ADMINISTRATOR', 'MERCHANT', 'CUSTOMER')),
  CONSTRAINT chk_membership_status CHECK (status IN ('ACTIVE', 'INVITED', 'SUSPENDED'))
);

CREATE INDEX IF NOT EXISTS idx_tenant_memberships_user ON tenant_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant ON tenant_memberships(tenant_id);

-- Refresh Tokens: Server-side token state with family-based rotation and reuse detection
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  family_id VARCHAR(36) NOT NULL,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
  is_rotated BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  rotated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- Security Audit Events: Append-only record of security and authorization decisions
CREATE TABLE IF NOT EXISTS security_audit_events (
  id VARCHAR(36) PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL,
  actor_id VARCHAR(36),
  tenant_id VARCHAR(36),
  ip_address VARCHAR(64),
  user_agent VARCHAR(255),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_security_audit_actor ON security_audit_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_security_audit_tenant ON security_audit_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_security_audit_type ON security_audit_events(event_type);
