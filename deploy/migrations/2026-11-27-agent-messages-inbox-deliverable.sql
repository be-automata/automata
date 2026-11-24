-- migrate:no-transaction
--
-- #767: the agent-bus inbox index, narrowed to deliverable rows
-- (`consumed_at IS NULL AND dead_lettered_at IS NULL`, the `deliverable`
-- predicate of model/agent-bus/messages.ts). Dead-lettered rows (#758) leave
-- the index, so the receiveFor claim and the sweeper's target scan no longer
-- walk past them. Built CONCURRENTLY so writes are not blocked; the old
-- `agent_messages_inbox` is dropped by the next file, after this one exists.
-- Name and predicate match packages/shared/src/db/schema.ts (schema-drift CI).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_messages_inbox_deliverable" ON "agent_messages" USING btree ("to_run","id") WHERE consumed_at is null and dead_lettered_at is null;
