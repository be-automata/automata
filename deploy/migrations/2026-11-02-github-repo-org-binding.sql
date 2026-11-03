-- migrate:expand
--
-- Per-repo org override for a shared GitHub App installation.
-- github_repo_org_binding routes one repo's installation-resolved events
-- (mentions, mirror intake, merged-PR audits) to its own org instead of the
-- installation's; no row keeps today's behaviour. Additive and idempotent:
-- apply BEFORE deploying the www revision that reads it (migrate.yml does this
-- on green main CI). Names and types match packages/shared/src/db/schema.ts
-- (githubRepoOrgBinding) exactly (schema-drift CI).

CREATE TABLE IF NOT EXISTS "github_repo_org_binding" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repo_full_name" text NOT NULL,
  "organization_id" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "github_repo_org_binding_repo_full_name_unique" UNIQUE("repo_full_name")
);

DO $$ BEGIN
  ALTER TABLE "github_repo_org_binding"
    ADD CONSTRAINT "github_repo_org_binding_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
