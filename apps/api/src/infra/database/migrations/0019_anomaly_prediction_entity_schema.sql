-- Migration 0019: allow anomaly predictions scoped to orders
-- ANOMALY_DETECTION flags individual orders for manual review, so the
-- predictions table accepts ORDER entities alongside PRODUCT/SKU/CUSTOMER.
ALTER TABLE ml_predictions DROP CONSTRAINT IF EXISTS chk_ml_pred_entity;
ALTER TABLE ml_predictions
  ADD CONSTRAINT chk_ml_pred_entity CHECK (
    entity_type IN ('PRODUCT', 'SKU', 'CUSTOMER', 'ORDER')
  );
