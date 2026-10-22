-- migrate:expand
--
-- #446: when a chat entered the concurrency queue (`queued-tasks-concurrency`).
-- The dequeue's stale-retirement rules age a queued run from this instant
-- instead of the thread's creation time, and only treat a closed source
-- PR/issue as stale when it closed AFTER this instant. Set once per queue
-- period by updateThreadChatStatusAtomic (COALESCE, so a re-queue after a
-- failed start keeps the first value); cleared when the chat boots.
--
-- On both tables: a legacy thread (no thread_chat row, which is every
-- production thread while enableThreadChatCreation is off) keeps its chat
-- status on the thread row, so its queue entry is stamped there.
--
-- Nullable, no default, no backfill: rows queued before the deploy keep NULL
-- and the dequeue falls back to the row's pre-dequeue updated_at. Apply
-- BEFORE deploying the www revision that writes it (migrate.yml does this on
-- green main CI). Names and types match packages/shared/src/db/schema.ts
-- (threadChatShared.queuedAt).

ALTER TABLE thread ADD COLUMN IF NOT EXISTS queued_at timestamptz;

ALTER TABLE thread_chat ADD COLUMN IF NOT EXISTS queued_at timestamptz;
