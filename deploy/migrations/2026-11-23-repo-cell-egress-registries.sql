-- migrate:expand
--
-- #705 (OD-2): the per-repo opt-in that adds the package-registry bundle
-- (`automata/registries@1`) to a cell's egress. Nullable, no default, no backfill:
-- NULL and false both mean off, so every existing row keeps today's platform-only
-- cell egress. Apply BEFORE deploying the www revision that reads it (migrate.yml
-- does this on green main CI). Name and type match packages/shared/src/db/schema.ts
-- (repoReviewSettings.cellEgressRegistries).

ALTER TABLE "repo_review_settings" ADD COLUMN IF NOT EXISTS "cell_egress_registries" boolean;

-- Post-migration verification:
--   \d repo_review_settings
--   pnpm exec tsx deploy/assert-schema-ready.ts
