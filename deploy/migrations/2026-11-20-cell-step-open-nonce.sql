-- migrate:expand
--
-- #656 PR-C: the request nonce of the open that made a cell step's current attempt.
-- openNextAttempt takes a caller-supplied nonce: a repeat of the same nonce returns the
-- same attempt instead of burning and fencing a new one (a lost response plus a retry).
-- open_nonce is nullable, no default, no backfill: rows opened before the deploy or by
-- openStep keep NULL (never a replay).
--
-- open_seq is the open sequence fence: every openNextAttempt (advance or replay) increments
-- it under the step lock and mintBearer({ replaceOthers }) refuses once a newer open has
-- happened, so a slow earlier request can never delete the bearer a retry handed out.
-- NOT NULL DEFAULT 0 with a constant is metadata-only (PG11+), no table rewrite.
--
-- Apply BEFORE deploying the www revision that writes them (migrate.yml does this on green
-- main CI; assert-schema-ready enforces it).
-- Names and types match packages/shared/src/db/schema.ts (cellStep.openNonce, openSeq).

ALTER TABLE "cell_step" ADD COLUMN IF NOT EXISTS "open_nonce" text;
ALTER TABLE "cell_step" ADD COLUMN IF NOT EXISTS "open_seq" integer NOT NULL DEFAULT 0;

-- Post-migration verification:
--   \d cell_step
--   pnpm exec tsx deploy/assert-schema-ready.ts
