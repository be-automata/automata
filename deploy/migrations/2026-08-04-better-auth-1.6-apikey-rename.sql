-- better-auth 1.3.25 -> 1.6.25: apikey owner column rename.
--
-- RUN THIS BEFORE `pnpm -C packages/shared drizzle-kit-push-prod`.
--
-- WHY THIS EXISTS. This repo manages schema with `drizzle-kit push` (no
-- migrations dir). A column RENAME is the one change push cannot infer safely:
-- it sees `user_id` dropped and `reference_id` added, and either
--   (a) prompts "is user_id renamed to reference_id?" — wrong answer or a
--       non-interactive run picks drop+create, or
--   (b) fails outright, because `reference_id` is NOT NULL with no default and
--       the table is non-empty.
-- Path (a) DESTROYS the owner linkage of every API key: every daemon token and
-- every CLI token in the fleet stops authenticating. This script does the
-- rename explicitly and preserves the data, after which `push` sees no diff.
--
-- Idempotent: safe to re-run, and safe on a database already migrated.

BEGIN;

-- 1. Rename the owner column (better-auth 1.5 renamed apiKey.userId ->
--    referenceId). Guarded so a re-run is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'apikey' AND column_name = 'user_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'apikey' AND column_name = 'reference_id'
  ) THEN
    ALTER TABLE "apikey" RENAME COLUMN "user_id" TO "reference_id";
  END IF;
END $$;

-- 2. Add the new configId column (better-auth 1.5, defaults to 'default').
--    Additive and safe; the DEFAULT backfills existing rows in place.
ALTER TABLE "apikey"
  ADD COLUMN IF NOT EXISTS "config_id" text NOT NULL DEFAULT 'default';

COMMIT;

-- Verify (expect: reference_id present, config_id present, user_id absent,
-- and zero rows with a null owner):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'apikey' AND column_name IN
--          ('user_id','reference_id','config_id');
--   SELECT count(*) FROM apikey WHERE reference_id IS NULL;
