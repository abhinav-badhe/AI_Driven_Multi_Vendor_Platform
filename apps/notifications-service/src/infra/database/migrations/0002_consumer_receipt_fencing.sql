-- 0002_consumer_receipt_fencing.sql
-- Add claim_token to notification_consumer_receipts to fence receipt state updates against stale/interrupted workers
ALTER TABLE notification_consumer_receipts
ADD COLUMN IF NOT EXISTS claim_token VARCHAR(64);
