-- migrate:expand
--
-- Knowledge controls get their own optimistic-concurrency stamp. Until now
-- the knowledge kill switch / budget / offboarding shared
-- organization_review_settings.updated_at with the PR-review settings, so a
-- save on either page made the other answer a spurious 409. Knowledge writes
-- now stamp knowledge_updated_at only. Nullable, no default: NULL means no
-- knowledge write yet. Additive and idempotent: apply BEFORE deploying the www
-- revision that reads it (migrate.yml does this on green main CI). Name and
-- type match packages/shared/src/db/schema.ts (schema-drift CI).

ALTER TABLE "organization_review_settings"
  ADD COLUMN IF NOT EXISTS "knowledge_updated_at" timestamp;

-- Post-migration verification:
--   \d organization_review_settings
--   DATABASE_URL=... pnpm exec tsx deploy/assert-schema-ready.ts   -- exit 0
