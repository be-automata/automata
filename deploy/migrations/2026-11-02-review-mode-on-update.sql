-- migrate:expand
--
-- The review mode an UPDATE review run uses (a pushed head or a base
-- retarget), instead of review_mode. Lets a repo run the orchestrated review
-- when a PR opens and the classic one on every later push. Same family and
-- inherit chain as review_mode (repo row -> '*' org-default row); NULL on both
-- = use review_mode, i.e. today's behaviour. Validated in code
-- (model/review-agent-settings.ts), so no CHECK constraint.
--
-- Nullable, no default, no backfill. Apply BEFORE deploying the www revision
-- that reads it (migrate.yml does this on green main CI). Name and type match
-- packages/shared/src/db/schema.ts (repoReviewSettings.reviewModeOnUpdate).

ALTER TABLE repo_review_settings ADD COLUMN IF NOT EXISTS review_mode_on_update text;
