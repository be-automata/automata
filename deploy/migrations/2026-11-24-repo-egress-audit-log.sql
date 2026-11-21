-- migrate:expand
--
-- #728 (OD-3): append-only audit of repo egress changes, one row per accepted change, written
-- in the same transaction as the repo_review_settings update. New table, no backfill. Apply
-- BEFORE deploying the www revision that writes it (migrate.yml does this on green main CI).
-- Names and types match packages/shared/src/db/schema.ts (repoEgressAuditLog; schema-drift CI).

CREATE TABLE IF NOT EXISTS "repo_egress_audit_log" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "repo_full_name" text NOT NULL,
  "actor_user_id" text NOT NULL,
  "auth_kind" text NOT NULL,
  "credential_id" text,
  "level_before" text,
  "level_after" text,
  "hosts_added" text[] NOT NULL,
  "hosts_removed" text[] NOT NULL,
  "registries_before" boolean,
  "registries_after" boolean,
  "created_at" timestamp(3) DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "repo_egress_audit_log"
    ADD CONSTRAINT "repo_egress_audit_log_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The table is created in this file, so a plain CREATE INDEX blocks no traffic (lint L3).
-- "id" last: the history's keyset cursor (created_at, id) reads this index in order.
CREATE INDEX IF NOT EXISTS "repo_egress_audit_log_org_repo_created_index"
  ON "repo_egress_audit_log" USING btree ("organization_id", "repo_full_name", "created_at", "id");

-- Post-migration verification:
--   \d repo_egress_audit_log
--   pnpm exec tsx deploy/assert-schema-ready.ts
