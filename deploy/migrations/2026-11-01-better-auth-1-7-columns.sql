-- migrate:expand
--
-- better-auth 1.6.26 -> 1.7.14 closes GHSA-965c-763c-88jm (critical: an OAuth
-- state value could be replayed as a magic link to sign in as another user).
-- 1.7 validates the Drizzle schema at startup and its organization and stripe
-- plugins declare six new fields; a missing column fails every auth call with
-- "Drizzle schema mismatch". Additive and idempotent: the running 1.6 revision
-- ignores these columns, so apply BEFORE deploying the www revision on 1.7
-- (migrate.yml does this on green main CI). Names and types match
-- packages/shared/src/db/schema.ts (schema-drift CI).
--
-- invitation.created_at is NOT NULL with DEFAULT now() like every other
-- created_at here; existing invitations get the migration time.

ALTER TABLE "invitation"
  ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;

ALTER TABLE "subscription"
  ADD COLUMN IF NOT EXISTS "cancel_at" timestamp,
  ADD COLUMN IF NOT EXISTS "canceled_at" timestamp,
  ADD COLUMN IF NOT EXISTS "ended_at" timestamp,
  ADD COLUMN IF NOT EXISTS "billing_interval" text,
  ADD COLUMN IF NOT EXISTS "stripe_schedule_id" text;

-- Post-migration verification:
--   \d invitation
--   \d subscription
--   DATABASE_URL=... pnpm exec tsx deploy/assert-schema-ready.ts   -- exit 0
