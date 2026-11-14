-- migrate:expand
--
-- Per-org opt-in letting remote cells push changes to .github/workflows (#609).
-- NULL and false both mean off; the resolver supplies the default, the column
-- has none. Apply BEFORE deploying the www revision that reads this column.
ALTER TABLE "organization_review_settings" ADD COLUMN IF NOT EXISTS "cell_workflow_write" boolean;
