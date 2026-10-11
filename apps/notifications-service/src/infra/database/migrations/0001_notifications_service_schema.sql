-- Migration: 0001_notifications_service_schema.sql
-- Bounded Context: Notifications Microservice
-- Description: Standalone schema for notifications delivery, preferences, and consumer deduplication

-- 1. Customer Notification Preferences: Channels and type opt-outs
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

-- 2. Notifications: Delivery lifecycle, channels, templates, and idempotency
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

-- 3. Notification Consumer Receipts: Durable consumer deduplication receipts (at-least-once idempotency)
CREATE TABLE IF NOT EXISTS notification_consumer_receipts (
  id VARCHAR(64) PRIMARY KEY,
  consumer_name VARCHAR(128) NOT NULL,
  event_id VARCHAR(64) NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(32) NOT NULL DEFAULT 'COMPLETED',
  error_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_notification_consumer_receipt UNIQUE (consumer_name, event_id),
  CONSTRAINT chk_notification_receipt_status CHECK (status IN ('PROCESSING', 'COMPLETED', 'SKIPPED', 'FAILED', 'QUARANTINED'))
);

CREATE INDEX IF NOT EXISTS idx_notification_consumer_receipts_event ON notification_consumer_receipts(event_id);
CREATE INDEX IF NOT EXISTS idx_notification_consumer_receipts_consumer ON notification_consumer_receipts(consumer_name);
