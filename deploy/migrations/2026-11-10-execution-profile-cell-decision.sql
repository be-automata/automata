-- migrate:expand
--
-- ADR-014 Testing step 5, slice 1: the execution-profile data model and the
-- record of every allow_cell decision.
--   execution_profile  catalog of (provider, tier, configuration); Decision 2
--   profile_evidence   one row per measured capability; expires_at is
--                      GENERATED as measured_at + 30 days (Decision 3)
--   cell_decision      one row per decision at a seam (dispatch today), in
--                      shadow mode: recorded, never refusing a run
-- Additive and idempotent: apply BEFORE deploying the www revision that writes
-- cell_decision (migrate.yml does this on green main CI). Until it is applied,
-- the shadow resolver's insert fails, is logged, and the dispatch proceeds.
-- Names and types match packages/shared/src/db/schema.ts (executionProfile,
-- profileEvidence, cellDecision) exactly (schema-drift CI).

CREATE TABLE IF NOT EXISTS "execution_profile" (
  "id" text PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "tier" text NOT NULL,
  "configuration" jsonb NOT NULL,
  "config_hash" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "profile_evidence" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "profile_id" text NOT NULL,
  "capability" text NOT NULL,
  "measured_at" timestamp NOT NULL,
  "expires_at" timestamp GENERATED ALWAYS AS (measured_at + interval '30 days') STORED NOT NULL,
  "source" text NOT NULL,
  "artifact_digest" text,
  "platform_sha" text,
  "result" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "cell_decision" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "thread_id" text NOT NULL,
  "thread_chat_id" text NOT NULL,
  "organization_id" text,
  "profile_id" text,
  "allowed" boolean NOT NULL,
  "reasons" text[] NOT NULL,
  "evidence_ids" text[] NOT NULL,
  "seam" text NOT NULL,
  "mode" text NOT NULL,
  "input" jsonb,
  "decided_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "profile_evidence"
    ADD CONSTRAINT "profile_evidence_profile_id_execution_profile_id_fk"
    FOREIGN KEY ("profile_id") REFERENCES "public"."execution_profile"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cell_decision"
    ADD CONSTRAINT "cell_decision_thread_id_thread_id_fk"
    FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cell_decision"
    ADD CONSTRAINT "cell_decision_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cell_decision"
    ADD CONSTRAINT "cell_decision_profile_id_execution_profile_id_fk"
    FOREIGN KEY ("profile_id") REFERENCES "public"."execution_profile"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "execution_profile_provider_tier_config_index"
  ON "execution_profile" USING btree ("provider","tier","config_hash");
CREATE INDEX IF NOT EXISTS "profile_evidence_profile_capability_index"
  ON "profile_evidence" USING btree ("profile_id","capability","measured_at");
CREATE INDEX IF NOT EXISTS "cell_decision_thread_id_index"
  ON "cell_decision" USING btree ("thread_id");
CREATE INDEX IF NOT EXISTS "cell_decision_org_decided_at_index"
  ON "cell_decision" USING btree ("organization_id","decided_at");

-- Post-migration verification:
--   \d execution_profile
--   \d profile_evidence
--   \d cell_decision
--   DATABASE_URL=... pnpm exec tsx deploy/assert-schema-ready.ts   -- exit 0
