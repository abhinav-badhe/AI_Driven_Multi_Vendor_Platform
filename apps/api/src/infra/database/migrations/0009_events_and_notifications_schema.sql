-- Migration: 0009_events_and_notifications_schema.sql
-- Description: Durable Transactional Outbox, Consumer Receipts, and Notifications Schema
-- Bounded Context: events, notifications

-- 1. Transactional Outbox Events: Durable atomic event recording table
CREATE TABLE IF NOT EXISTS outbox_events (
  event_id VARCHAR(64) PRIMARY KEY,
  event_type VARCHAR(128) NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id VARCHAR(64) NOT NULL,
  tenant_id VARCHAR(36) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_expires_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_outbox_status CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'DEAD_LETTERED')),
  CONSTRAINT chk_outbox_attempts CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_outbox_events_status_available ON outbox_events(status, available_at);
CREATE INDEX IF NOT EXISTS idx_outbox_events_lease ON outbox_events(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_outbox_events_aggregate ON outbox_events(aggregate_type, aggregate_id);
CREATE INDEX IF NOT EXISTS idx_outbox_events_tenant ON outbox_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_outbox_events_type ON outbox_events(event_type);

-- 2. Event Consumer Receipts: Durable consumer deduplication receipts (at-least-once delivery idempotency)
CREATE TABLE IF NOT EXISTS event_consumer_receipts (
  id VARCHAR(64) PRIMARY KEY,
  consumer_name VARCHAR(128) NOT NULL,
  event_id VARCHAR(64) NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(32) NOT NULL DEFAULT 'COMPLETED',
  error_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_consumer_event_receipt UNIQUE (consumer_name, event_id),
  CONSTRAINT chk_receipt_status CHECK (status IN ('PROCESSING', 'COMPLETED', 'SKIPPED', 'FAILED', 'QUARANTINED'))
);

CREATE INDEX IF NOT EXISTS idx_consumer_receipts_event ON event_consumer_receipts(event_id);
CREATE INDEX IF NOT EXISTS idx_consumer_receipts_consumer ON event_consumer_receipts(consumer_name);

-- 3. Customer Notification Preferences: Channels and type opt-outs
CREATE TABLE IF NOT EXISTS customer_notification_preferences (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL,
  customer_id VARCHAR(64) NOT NULL,
  email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sms_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  disabled_types TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_customer_pref UNIQUE (tenant_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_pref_cust ON customer_notification_preferences(tenant_id, customer_id);

-- 4. Notifications: Delivery lifecycle, channels, templates, and idempotency
CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL,
  event_id VARCHAR(64) NOT NULL,
  notification_type VARCHAR(64) NOT NULL,
  channel VARCHAR(32) NOT NULL,
  recipient VARCHAR(255) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  template_id VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_notification_channel CHECK (channel IN ('EMAIL', 'SMS', 'PUSH')),
  CONSTRAINT chk_notification_status CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'RETRY_SCHEDULED', 'DEAD_LETTERED')),
  CONSTRAINT chk_notification_attempts CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_notifications_status_available ON notifications(status, available_at);
CREATE INDEX IF NOT EXISTS idx_notifications_tenant ON notifications(tenant_id);
CREATE INDEX IF NOT EXISTS idx_notifications_event ON notifications(event_id);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient);
