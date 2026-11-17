-- migrate:expand
-- Agent bus S1 (#659): one row per run in a tree of runs. root_thread_id is the root of the
-- tree (the run's own thread for a root); lane and capabilities are what the run was granted.
-- Additive and idempotent: apply BEFORE deploying the revision that reads this table
-- (migrate.yml does this on green main CI). Names and types match
-- packages/shared/src/db/schema.ts exactly (schema-drift CI).

CREATE TABLE IF NOT EXISTS "agent_run" (
  "thread_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "parent_thread_id" text,
  "root_thread_id" text NOT NULL,
  "lane" text NOT NULL,
  "capabilities" jsonb NOT NULL,
  "depth" integer DEFAULT 0 NOT NULL,
  "outlive_parent" boolean DEFAULT false NOT NULL,
  "deadline" timestamp,
  "blocked_at" timestamp,
  "blocked_reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_thread_id_thread_id_fk"
    FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_parent_thread_id_thread_id_fk"
    FOREIGN KEY ("parent_thread_id") REFERENCES "public"."thread"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- root_thread_id has no foreign key on purpose: deleting a root's thread must not delete its
-- descendants' rows (they stay narrowed; a former child never re-registers as a root).

CREATE INDEX IF NOT EXISTS "agent_run_parent_thread_id_index" ON "agent_run" USING btree ("parent_thread_id");
CREATE INDEX IF NOT EXISTS "agent_run_root_thread_id_index" ON "agent_run" USING btree ("root_thread_id");
CREATE INDEX IF NOT EXISTS "agent_run_organization_id_index" ON "agent_run" USING btree ("organization_id");
