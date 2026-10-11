-- Migration 0026: Two-Factor Authentication (TOTP & Recovery Codes)
-- Author: Security & Identity Architecture

CREATE TABLE IF NOT EXISTS user_two_factor_auth (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret VARCHAR(64) NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  recovery_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_user_two_factor UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_two_factor_user_id ON user_two_factor_auth(user_id);
