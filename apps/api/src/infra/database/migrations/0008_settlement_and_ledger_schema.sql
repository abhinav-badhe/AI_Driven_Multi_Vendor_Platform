-- Migration: 0008_settlement_and_ledger_schema.sql
-- Description: Marketplace Finance / Settlement & Ledger Schema
-- Bounded Context: settlement-ledger
-- Authoritative owner of seller balances, earnings, commissions, fees, refunds, adjustments, settlements, and ledger entries.

-- 1. Financial Accounts: Authoritative financial account per tenant/currency
CREATE TABLE IF NOT EXISTS financial_accounts (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  currency VARCHAR(3) NOT NULL,
  current_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  pending_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  settled_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_financial_account UNIQUE (tenant_id, currency),
  CONSTRAINT chk_financial_account_currency CHECK (currency IN ('USD', 'INR', 'EUR', 'GBP')),
  CONSTRAINT chk_financial_account_version CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS idx_financial_accounts_tenant ON financial_accounts(tenant_id);

-- 2. Financial Adjustments: Manual, dispute, or promotional balance adjustments
CREATE TABLE IF NOT EXISTS financial_adjustments (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  amount NUMERIC(12,2) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  type VARCHAR(32) NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'APPROVED',
  actor_id VARCHAR(36) NOT NULL,
  actor_type VARCHAR(32) NOT NULL DEFAULT 'ADMINISTRATOR',
  idempotency_key VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_financial_adj_amount CHECK (amount > 0),
  CONSTRAINT chk_financial_adj_type CHECK (type IN ('CREDIT', 'DEBIT')),
  CONSTRAINT chk_financial_adj_status CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED')),
  CONSTRAINT uq_financial_adj_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_financial_adj_tenant ON financial_adjustments(tenant_id);

-- 3. Settlements: Settlement cycles and payout records per merchant/period
CREATE TABLE IF NOT EXISTS settlements (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  currency VARCHAR(3) NOT NULL,
  gross_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  commission_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  refund_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  adjustment_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  net_payable_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  idempotency_key VARCHAR(128),
  snapshot_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_settlement_status CHECK (
    status IN ('PENDING', 'CALCULATED', 'APPROVED', 'PROCESSING', 'SETTLED', 'FAILED', 'REJECTED')
  ),
  CONSTRAINT chk_settlement_period CHECK (period_end >= period_start),
  CONSTRAINT uq_settlement_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_settlements_tenant ON settlements(tenant_id);
CREATE INDEX IF NOT EXISTS idx_settlements_status ON settlements(status);
CREATE INDEX IF NOT EXISTS idx_settlements_period ON settlements(period_start, period_end);

-- 4. Ledger Entries: Immutable, append-only financial records
CREATE TABLE IF NOT EXISTS ledger_entries (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  account_id VARCHAR(36) NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  entry_type VARCHAR(32) NOT NULL,
  direction VARCHAR(8) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  source_type VARCHAR(32) NOT NULL,
  source_id VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  reason VARCHAR(255),
  actor_id VARCHAR(36) NOT NULL,
  actor_type VARCHAR(32) NOT NULL,
  idempotency_key VARCHAR(128),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_ledger_entry_amount CHECK (amount > 0),
  CONSTRAINT chk_ledger_entry_type CHECK (
    entry_type IN ('EARNING', 'COMMISSION', 'FEE', 'REFUND', 'ADJUSTMENT', 'PAYOUT', 'CLEARING', 'COMMISSION_REVENUE', 'FEE_REVENUE', 'REFUND_REVERSAL')
  ),
  CONSTRAINT chk_ledger_entry_direction CHECK (direction IN ('CREDIT', 'DEBIT')),
  CONSTRAINT uq_ledger_entry_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT uq_ledger_source_type_entry UNIQUE (tenant_id, source_type, source_id, entry_type)
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_tenant ON ledger_entries(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_created ON ledger_entries(created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_source ON ledger_entries(source_type, source_id);

-- 5. Settlement Items: Immutable junction between settlement batches and ledger entries
CREATE TABLE IF NOT EXISTS settlement_items (
  id VARCHAR(36) PRIMARY KEY,
  settlement_id VARCHAR(36) NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  ledger_entry_id VARCHAR(36) NOT NULL REFERENCES ledger_entries(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_settlement_ledger_entry UNIQUE (settlement_id, ledger_entry_id),
  CONSTRAINT uq_ledger_entry_single_settlement UNIQUE (ledger_entry_id)
);

CREATE INDEX IF NOT EXISTS idx_settlement_items_settlement ON settlement_items(settlement_id);
CREATE INDEX IF NOT EXISTS idx_settlement_items_ledger ON settlement_items(ledger_entry_id);
