-- migrate:expand
--
-- #374: per-org Hatchet tenant map. hatchet_tenant_binding maps an
-- (organization, repo-or-'*') to an engine tenant and its encrypted API
-- token; hatchet_run.tenant_id (nullable, NULL = env tenant) records the
-- tenant a run was dispatched into. Additive and idempotent: apply BEFORE
-- deploying the www revision that reads it (migrate.yml does this on green
-- main CI). Names and types match packages/shared/src/db/schema.ts
-- (hatchetTenantBinding, hatchetRun.tenantId) exactly (schema-drift CI).

ALTER TABLE "hatchet_run" ADD COLUMN IF NOT EXISTS "tenant_id" text;

CREATE TABLE IF NOT EXISTS "hatchet_tenant_binding" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "repo_full_name" text NOT NULL,
  "tenant_id" text NOT NULL,
  "api_url" text,
  "api_token_encrypted" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "hatchet_tenant_binding"
    ADD CONSTRAINT "hatchet_tenant_binding_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "hatchet_tenant_binding_org_repo_unique"
  ON "hatchet_tenant_binding" USING btree ("organization_id","repo_full_name");
