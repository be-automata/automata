-- Org-level environment variables (organization_environment) and their
-- keys-only write log (organization_environment_event). Additive and
-- idempotent: run BEFORE deploying the www revision that reads these tables
-- (the tracker resolver and agent env assembly read organization_environment
-- on every call), then gate with deploy/assert-schema-ready.ts.
--
-- Hand-written instead of `drizzle-kit push` because push on prod also churns
-- the audit_fix_attempts_pr_repo_lower_index expression index (see
-- PILOT-RUNBOOK.md). Names match the Drizzle definitions in
-- packages/shared/src/db/schema.ts exactly, so a later push sees no diff for
-- these tables.

CREATE TABLE IF NOT EXISTS "organization_environment" (
  "organization_id" text PRIMARY KEY NOT NULL,
  "environment_variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "updated_by_user_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "organization_environment_event" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "actor_user_id" text NOT NULL,
  "added_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "removed_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "changed_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "organization_environment"
    ADD CONSTRAINT "organization_environment_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "organization_environment"
    ADD CONSTRAINT "organization_environment_updated_by_user_id_user_id_fk"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "organization_environment_event"
    ADD CONSTRAINT "organization_environment_event_org_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "organization_environment_event_org_created_index"
  ON "organization_environment_event" USING btree ("organization_id","created_at");

-- Post-migration verification:
--   \d organization_environment
--   \d organization_environment_event
--   SELECT conname FROM pg_constraint
--    WHERE conrelid IN ('organization_environment'::regclass,
--                       'organization_environment_event'::regclass);
--   -- expect 2 PKs + 3 FKs
--   DATABASE_URL=... pnpm exec tsx deploy/assert-schema-ready.ts   -- exit 0
