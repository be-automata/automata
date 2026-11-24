-- migrate:expand
-- #769: the persisted cursor of the agent_messages consumed-pass prune (follow-up of #759 / PR #763).
-- A new one-row table, no backfill, nothing dropped. An empty table means "start from the
-- beginning", which is today's behaviour, so the order against the deploy does not matter;
-- migrate.yml applies it on green main CI. Names and types match
-- packages/shared/src/db/schema.ts (schema-drift CI).

CREATE TABLE IF NOT EXISTS "agent_message_prune_cursor" (
  "id" text PRIMARY KEY DEFAULT 'consumed' NOT NULL,
  "consumed_at" timestamp with time zone NOT NULL,
  "msg_id" bigint NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Post-migration verification:
--   \d agent_message_prune_cursor
--   pnpm exec tsx deploy/assert-schema-ready.ts
