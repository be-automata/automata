-- migrate:expand
--
-- #743 (OD-3): the head pointer of a cell session checkpoint, and the ledger that bounds how
-- often a timed-out run hands its session to a new cell. New tables, no backfill, nothing
-- dropped. Apply BEFORE deploying the www revision that writes them (migrate.yml does this on
-- green main CI). Names and types match packages/shared/src/db/schema.ts (schema-drift CI).

CREATE TABLE IF NOT EXISTS "cell_session_checkpoint" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "thread_id" text NOT NULL,
  "thread_chat_id" text NOT NULL,
  "organization_id" text,
  "session_id" text NOT NULL,
  "head_manifest_id" text NOT NULL,
  "head_turn" integer NOT NULL,
  "native_bytes" integer NOT NULL,
  "call_index_sha256" text,
  "version" integer DEFAULT 1 NOT NULL,
  "last_run_external_id" text NOT NULL,
  "created_at" timestamp(3) DEFAULT now() NOT NULL,
  "updated_at" timestamp(3) DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "cell_session_continuation" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "thread_id" text NOT NULL,
  "thread_chat_id" text NOT NULL,
  "ordinal" integer NOT NULL,
  "source_run_external_id" text NOT NULL,
  "checkpoint_manifest_id" text NOT NULL,
  "checkpoint_turn" integer NOT NULL,
  "state" text DEFAULT 'claimed' NOT NULL,
  "created_at" timestamp(3) DEFAULT now() NOT NULL,
  "updated_at" timestamp(3) DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "cell_session_checkpoint"
    ADD CONSTRAINT "cell_session_checkpoint_thread_id_thread_id_fk"
    FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cell_session_checkpoint"
    ADD CONSTRAINT "cell_session_checkpoint_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cell_session_continuation"
    ADD CONSTRAINT "cell_session_continuation_thread_id_thread_id_fk"
    FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The tables are created in this file, so plain CREATE UNIQUE INDEX blocks no traffic (lint L3).
CREATE UNIQUE INDEX IF NOT EXISTS "cell_session_checkpoint_thread_chat_unique"
  ON "cell_session_checkpoint" USING btree ("thread_id", "thread_chat_id");

CREATE UNIQUE INDEX IF NOT EXISTS "cell_session_continuation_thread_ordinal_unique"
  ON "cell_session_continuation" USING btree ("thread_id", "ordinal");

CREATE UNIQUE INDEX IF NOT EXISTS "cell_session_continuation_source_run_unique"
  ON "cell_session_continuation" USING btree ("source_run_external_id");

-- Post-migration verification:
--   \d cell_session_checkpoint
--   \d cell_session_continuation
--   pnpm exec tsx deploy/assert-schema-ready.ts
