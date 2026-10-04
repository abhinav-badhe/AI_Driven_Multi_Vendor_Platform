-- Migration: 0014_financial_transactions_and_account_types.sql
-- Description: Explicit double-entry financial transactions and account types

-- 1. Financial Transactions: Journal boundary grouping debit and credit entries
CREATE TABLE IF NOT EXISTS financial_transactions (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  transaction_type VARCHAR(32) NOT NULL,
  source_type VARCHAR(32) NOT NULL,
  source_id VARCHAR(255) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  idempotency_key VARCHAR(128),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_fin_tx_currency CHECK (currency IN ('USD', 'INR', 'EUR', 'GBP')),
  CONSTRAINT chk_fin_tx_type CHECK (
    transaction_type IN ('ORDER_EARNING', 'COMMISSION', 'FEE', 'REFUND', 'COMMISSION_REVERSAL', 'ADJUSTMENT', 'PAYOUT')
  ),
  CONSTRAINT uq_fin_tx_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT uq_fin_tx_source UNIQUE (tenant_id, source_type, source_id, transaction_type)
);

CREATE INDEX IF NOT EXISTS idx_fin_tx_tenant ON financial_transactions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_fin_tx_source ON financial_transactions(source_type, source_id);

-- 2. Add financial_transaction_id to ledger_entries
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS financial_transaction_id VARCHAR(36) REFERENCES financial_transactions(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_ledger_entries_fin_tx ON ledger_entries(financial_transaction_id);

-- 3. Enhance financial_accounts with explicit account_type
ALTER TABLE financial_accounts ADD COLUMN IF NOT EXISTS account_type VARCHAR(32) NOT NULL DEFAULT 'MERCHANT_BALANCE';

-- Drop the old single account per tenant constraint and replace with per (tenant_id, account_type, currency)
ALTER TABLE financial_accounts DROP CONSTRAINT IF EXISTS uq_financial_account;
ALTER TABLE financial_accounts ADD CONSTRAINT uq_financial_account_type UNIQUE (tenant_id, account_type, currency);
ALTER TABLE financial_accounts ADD CONSTRAINT chk_financial_account_type CHECK (
  account_type IN ('MERCHANT_BALANCE', 'CLEARING', 'COMMISSION_REVENUE', 'FEE_REVENUE', 'PAYOUT_CASH')
);
