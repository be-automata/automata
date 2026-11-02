-- migrate:expand
--
-- Merge-driven reconcile (Phase 13): per-repo push liveness. The push
-- listener in apps/www stamps knowledge_cursor.last_push_at with the newest
-- default-branch push it saw; NULL means the repo has never seen a push.
-- Nullable, no default. Additive and idempotent: apply BEFORE deploying the
-- www revision that writes it (migrate.yml does this on green main CI). Name
-- and type match packages/shared/src/db/schema.ts (schema-drift CI).

ALTER TABLE "knowledge_cursor"
  ADD COLUMN IF NOT EXISTS "last_push_at" timestamp;

-- Post-migration verification:
--   \d knowledge_cursor
--   DATABASE_URL=... pnpm exec tsx deploy/assert-schema-ready.ts   -- exit 0
