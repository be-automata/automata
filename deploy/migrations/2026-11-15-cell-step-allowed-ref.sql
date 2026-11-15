-- migrate:expand
--
-- The one ref a remote-cell step may push (#610). NULL means the step does not
-- push. Apply BEFORE deploying the www revision that reads this column.
ALTER TABLE "cell_step" ADD COLUMN IF NOT EXISTS "allowed_ref" text;
