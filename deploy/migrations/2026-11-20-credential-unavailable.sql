-- migrate:expand
--
-- #442 (epic #440 C2): per-credential unavailability.
--
-- agent_provider_credentials: a classified provider refusal (#441) marks the
-- credential the run was delivered. unavailable_until is the reset (NULL with
-- a reason set = indefinite: subscription disabled or credential rejected,
-- cleared only by an admin); unavailable_reason is the kind; marked_at is when
-- the mark last changed. Clearing both until and reason makes the row
-- available again.
--
-- thread / thread_chat: delivered_credential_id is the credential
-- /api/daemon/agent-credentials delivered to the run (NULL = built-in credits
-- or none), so the mark targets that row and never one an operator switched
-- to mid-run. On both tables (threadChatShared, as queued_at): a legacy thread
-- (no thread_chat row, which is every production thread while
-- enableThreadChatCreation is off) keeps its chat state on the thread row.
-- No foreign key: a deleted credential only makes the mark a no-op, and an FK
-- would validate by scanning the table.
--
-- Nullable, no default, no backfill. Apply BEFORE deploying the www revision
-- that writes them (migrate.yml does this on green main CI). Names and types
-- match packages/shared/src/db/schema.ts (agentProviderCredentials.unavailable*,
-- threadChatShared.deliveredCredentialId).

ALTER TABLE "agent_provider_credentials" ADD COLUMN IF NOT EXISTS "unavailable_until" timestamptz;

ALTER TABLE "agent_provider_credentials" ADD COLUMN IF NOT EXISTS "unavailable_reason" text;

ALTER TABLE "agent_provider_credentials" ADD COLUMN IF NOT EXISTS "unavailable_marked_at" timestamptz;

ALTER TABLE "thread" ADD COLUMN IF NOT EXISTS "delivered_credential_id" text;

ALTER TABLE "thread_chat" ADD COLUMN IF NOT EXISTS "delivered_credential_id" text;

-- Post-migration verification:
--   \d agent_provider_credentials
--   pnpm exec tsx deploy/assert-schema-ready.ts
