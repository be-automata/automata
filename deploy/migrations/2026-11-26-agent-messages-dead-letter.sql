-- migrate:expand
-- #758: poison-message dead-letter for the agent bus (follow-up of #660 / PR #689).
-- Additive and idempotent. ADD COLUMN ... NOT NULL DEFAULT 0 is metadata-only on PG 11+.
-- Apply BEFORE deploying the revision that reads these columns (migrate.yml does it on green main CI).
-- Names and types match packages/shared/src/db/schema.ts (schema-drift CI).
ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "last_error" text;
ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "dead_lettered_at" timestamp with time zone;
