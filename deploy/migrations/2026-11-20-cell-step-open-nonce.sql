-- migrate:expand
--
-- #656 PR-C: the request nonce of the open that made a cell step's current attempt.
-- openNextAttempt takes a caller-supplied nonce: a repeat of the same nonce returns the
-- same attempt instead of burning and fencing a new one (a lost response plus a retry).
-- Nullable, no default, no backfill: rows opened before the deploy, by openStep, or
-- without a nonce keep NULL (never a replay). Apply BEFORE deploying the www revision
-- that writes it (migrate.yml does this on green main CI; assert-schema-ready enforces it).
-- Names and types match packages/shared/src/db/schema.ts (cellStep.openNonce).

ALTER TABLE "cell_step" ADD COLUMN IF NOT EXISTS "open_nonce" text;

-- Post-migration verification:
--   \d cell_step
--   pnpm exec tsx deploy/assert-schema-ready.ts
