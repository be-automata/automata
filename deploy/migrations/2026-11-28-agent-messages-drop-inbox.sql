-- migrate:no-transaction
-- migrate:lint-ignore L1 drops a redundant index, not data: no query names agent_messages_inbox, and agent_messages_inbox_deliverable (2026-11-27, applied first) serves the claim and the sweep. A contract header would make the unattended migrate.yml refuse the whole plan, this file and the index build before it included.
--
-- #767: drop the old inbox index (`WHERE consumed_at IS NULL`), which also
-- held dead-lettered rows. Its replacement, agent_messages_inbox_deliverable,
-- is built by 2026-11-27-agent-messages-inbox-deliverable, which sorts first,
-- so no revision is left without an inbox index.

DROP INDEX CONCURRENTLY IF EXISTS "agent_messages_inbox";
