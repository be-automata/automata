-- migrate:expand
-- Agent bus S2 (#660): the message table (exactly-once delivery between runs) and the
-- applied ledger. Additive and idempotent: apply BEFORE deploying the revision that reads
-- these tables (migrate.yml does this on green main CI). Names and types match
-- packages/shared/src/db/schema.ts exactly (schema-drift CI).

CREATE TABLE IF NOT EXISTS "agent_messages" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "idem_key" text NOT NULL,
  "from_run" text NOT NULL,
  "to_run" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "consumed_at" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "agent_applied" (
  "msg_id" bigint PRIMARY KEY NOT NULL,
  "run" text NOT NULL,
  "applied_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "agent_applied" ADD CONSTRAINT "agent_applied_msg_id_agent_messages_id_fk"
    FOREIGN KEY ("msg_id") REFERENCES "public"."agent_messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_messages_idem" ON "agent_messages" USING btree ("from_run","idem_key");
CREATE INDEX IF NOT EXISTS "agent_messages_inbox" ON "agent_messages" USING btree ("to_run","id") WHERE consumed_at is null;
CREATE INDEX IF NOT EXISTS "agent_messages_consumed_at_index" ON "agent_messages" USING btree ("consumed_at") WHERE consumed_at is not null;
