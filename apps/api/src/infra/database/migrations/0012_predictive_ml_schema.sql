-- Migration: 0012_predictive_ml_schema.sql
-- Description: Predictive ML model registry, asynchronous training jobs, derived prediction store, and retraining policies.
-- Phase: 13 (Predictive ML)
-- Invariant: ML is an optional, derived intelligence layer.
-- It NEVER becomes the transactional source of truth for Orders, Inventory, Payment, Settlement, Catalog, or Customer truth.

-- 1. Predictive ML Model Registry
CREATE TABLE IF NOT EXISTS ml_models (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  model_type VARCHAR(64) NOT NULL,
  version VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'TRAINING',
  algorithm VARCHAR(64) NOT NULL,
  hyperparameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  feature_version VARCHAR(32) NOT NULL DEFAULT 'v1',
  training_dataset_id VARCHAR(64) NOT NULL,
  data_source_type VARCHAR(32) NOT NULL DEFAULT 'REAL',
  prediction_horizon VARCHAR(32) NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  artifact_path TEXT,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evaluated_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  CONSTRAINT chk_ml_model_status CHECK (
    status IN ('TRAINING', 'EVALUATING', 'APPROVED', 'REJECTED', 'RETIRED', 'FAILED')
  ),
  CONSTRAINT chk_ml_data_source CHECK (
    data_source_type IN ('REAL', 'BOOTSTRAP')
  ),
  CONSTRAINT uq_ml_model_tenant_type_version UNIQUE (tenant_id, model_type, version)
);

CREATE INDEX IF NOT EXISTS idx_ml_models_tenant_type ON ml_models (tenant_id, model_type);
CREATE INDEX IF NOT EXISTS idx_ml_models_tenant_active ON ml_models (tenant_id, model_type, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ml_active_approved_model ON ml_models (tenant_id, model_type) WHERE is_active = TRUE;

-- 2. Predictive ML Training Jobs (Durable Asynchronous Job Log)
CREATE TABLE IF NOT EXISTS ml_training_jobs (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  model_type VARCHAR(64) NOT NULL,
  trigger_type VARCHAR(32) NOT NULL DEFAULT 'MANUAL',
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  data_source_type VARCHAR(32) NOT NULL DEFAULT 'REAL',
  sample_count INT NOT NULL DEFAULT 0,
  model_id VARCHAR(64),
  error_message TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT chk_ml_job_status CHECK (
    status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')
  ),
  CONSTRAINT chk_ml_job_trigger CHECK (
    trigger_type IN ('MANUAL', 'SCHEDULED', 'MIN_DATA_THRESHOLD')
  )
);

CREATE INDEX IF NOT EXISTS idx_ml_jobs_tenant_status ON ml_training_jobs (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_ml_jobs_tenant_type ON ml_training_jobs (tenant_id, model_type);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ml_active_training_job ON ml_training_jobs (tenant_id, model_type) WHERE status IN ('PENDING', 'RUNNING');

-- 3. Predictive ML Derived Predictions Store
CREATE TABLE IF NOT EXISTS ml_predictions (
  id VARCHAR(64) PRIMARY KEY,
  scope_key VARCHAR(255) NOT NULL UNIQUE,
  tenant_id VARCHAR(64) NOT NULL,
  model_id VARCHAR(64) NOT NULL,
  model_version VARCHAR(32) NOT NULL,
  model_type VARCHAR(64) NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  prediction_value NUMERIC(14,4) NOT NULL DEFAULT 0.0000,
  probability NUMERIC(6,4),
  confidence NUMERIC(6,4),
  horizon VARCHAR(32) NOT NULL,
  feature_version VARCHAR(32) NOT NULL DEFAULT 'v1',
  data_source_type VARCHAR(32) NOT NULL DEFAULT 'REAL',
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  CONSTRAINT chk_ml_pred_entity CHECK (
    entity_type IN ('PRODUCT', 'SKU', 'CUSTOMER')
  ),
  CONSTRAINT chk_ml_pred_source CHECK (
    data_source_type IN ('REAL', 'BOOTSTRAP')
  )
);

CREATE INDEX IF NOT EXISTS idx_ml_pred_lookup ON ml_predictions (tenant_id, model_type, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_ml_pred_scope_key ON ml_predictions (scope_key);
CREATE INDEX IF NOT EXISTS idx_ml_pred_model_version ON ml_predictions (model_id, model_version);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ml_prediction_entity_version ON ml_predictions (tenant_id, model_type, entity_id, model_version);

-- 4. Predictive ML Retraining Policies
CREATE TABLE IF NOT EXISTS ml_retraining_policies (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  model_type VARCHAR(64) NOT NULL,
  min_new_orders_threshold INT NOT NULL DEFAULT 10,
  last_trained_order_count INT NOT NULL DEFAULT 0,
  last_trained_at TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ml_retraining_policy UNIQUE (tenant_id, model_type)
);

CREATE INDEX IF NOT EXISTS idx_ml_retraining_lookup ON ml_retraining_policies (tenant_id, model_type);
