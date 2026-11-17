-- migrate:expand
--
-- #656 R2: the lease of a cell step's current attempt. Stamped (database now()) when
-- openNextAttempt opens an attempt and by each thread-status read of a cell run (PR-D);
-- the reconciler counts the current attempt dead once it is unseen for 5 minutes.
-- Nullable, no default, no backfill: rows opened before the deploy (or by openStep) keep
-- NULL and are judged by revocation, fence, done and expiresAt only. Apply BEFORE
-- deploying the www revision that writes it (migrate.yml does this on green main CI).
-- Names and types match packages/shared/src/db/schema.ts (cellStep.lastSeenAt).

ALTER TABLE "cell_step" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamptz;

-- Post-migration verification:
--   \d cell_step
--   pnpm exec tsx deploy/assert-schema-ready.ts
