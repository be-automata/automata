-- Environment uniqueness by org + organization.is_personal.
--
-- Run BEFORE deploying the www revision that ships with it, then gate with
-- deploy/assert-schema-ready.ts. getOrCreateEnvironment names these indexes as
-- its ON CONFLICT targets, so code without them fails every environment
-- creation ("there is no unique or exclusion constraint matching the ON
-- CONFLICT specification").
--
-- Hand-written instead of `drizzle-kit push` for the same reason as
-- 2026-10-08-organization-environment.sql (push on prod also churns the
-- audit_fix_attempts_pr_repo_lower_index expression index), and because push
-- prompts interactively before adding a unique constraint to a table with
-- rows. Names match packages/shared/src/db/schema.ts exactly.
--
-- Requires Postgres 15+ (UNIQUE NULLS NOT DISTINCT).
--
-- PRE-CHECK (must return zero rows; the new constraints are strictly looser
-- than the old (user_id, repo_full_name) index, so on a healthy database they
-- do):
--
--   SELECT organization_id, user_id, repo_full_name, count(*)
--     FROM environment
--    GROUP BY organization_id, user_id, repo_full_name
--   HAVING count(*) > 1;
--
--   SELECT user_id, count(*) FROM environment
--    WHERE is_global = true GROUP BY user_id HAVING count(*) > 1;

ALTER TABLE "organization"
  ADD COLUMN IF NOT EXISTS "is_personal" boolean DEFAULT false NOT NULL;

-- Backfilled personal orgs are recognizable only by slug until now.
UPDATE "organization" SET "is_personal" = true
 WHERE "slug" LIKE 'personal-%' AND "is_personal" = false;

-- Add the new uniqueness BEFORE dropping the old index, so there is no window
-- in which the table has no uniqueness at all.
DO $$ BEGIN
  ALTER TABLE "environment"
    ADD CONSTRAINT "environment_org_user_repo_unique"
    UNIQUE NULLS NOT DISTINCT ("organization_id", "user_id", "repo_full_name");
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "environment_user_global_unique"
  ON "environment" USING btree ("user_id") WHERE "is_global" = true;

DROP INDEX IF EXISTS "user_id_repo_full_name_branch_name_unique";
