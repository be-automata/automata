-- migrate:expand
--
-- Knowledge org controls (Phase 12): the durable reconcile intent, the
-- append-only admin log, the platform settings singleton (budget ceiling),
-- the per-org kill switch / budget / offboarding columns, the cap-alert claim
-- on the usage window, and the evidence fingerprint on knowledge_op.
-- apps/www is the only writer. Apply BEFORE deploying the www revision that
-- reads these columns (migrate.yml does this on green main CI). Names and
-- types match packages/shared/src/db/schema.ts (schema-drift CI). Every added
-- column is nullable with NO default; the resolver supplies the defaults.
-- The matching index on knowledge_op.evidence_fingerprint is built
-- CONCURRENTLY in the next file.

CREATE TABLE IF NOT EXISTS "knowledge_intent" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "repo_full_name" text NOT NULL,
  "default_branch" text NOT NULL,
  "target_sha" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp DEFAULT now() NOT NULL,
  "last_error_code" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "processed_at" timestamp,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "knowledge_admin_log" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "actor_user_id" text NOT NULL,
  "action" text NOT NULL,
  "target" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "knowledge_platform_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "budget_ceiling_micro_usd" bigint,
  "updated_by_user_id" text,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "knowledge_platform_settings_singleton" CHECK ("id" = 'global')
);

DO $$ BEGIN
  ALTER TABLE "knowledge_intent"
    ADD CONSTRAINT "knowledge_intent_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "knowledge_admin_log"
    ADD CONSTRAINT "knowledge_admin_log_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_intent_org_repo_sha_unique"
  ON "knowledge_intent" USING btree ("organization_id","repo_full_name","target_sha");

CREATE INDEX IF NOT EXISTS "knowledge_intent_state_next_attempt_index"
  ON "knowledge_intent" USING btree ("state","next_attempt_at");

CREATE INDEX IF NOT EXISTS "knowledge_admin_log_org_created_index"
  ON "knowledge_admin_log" USING btree ("organization_id","created_at");

ALTER TABLE "organization_review_settings" ADD COLUMN IF NOT EXISTS "knowledge_engine" boolean;

ALTER TABLE "organization_review_settings" ADD COLUMN IF NOT EXISTS "knowledge_budget_micro_usd" bigint;

ALTER TABLE "organization_review_settings" ADD COLUMN IF NOT EXISTS "knowledge_offboarded_at" timestamp;

ALTER TABLE "organization_review_settings" ADD COLUMN IF NOT EXISTS "knowledge_purged_at" timestamp;

ALTER TABLE "knowledge_usage_window" ADD COLUMN IF NOT EXISTS "cap_alerted_at" timestamp;

ALTER TABLE "knowledge_op" ADD COLUMN IF NOT EXISTS "evidence_fingerprint" text;
