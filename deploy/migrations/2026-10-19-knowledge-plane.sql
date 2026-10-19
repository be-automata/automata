-- Knowledge plane, M1 governed-truth slice (docs/designs/knowledge-governed-truth-slice.md):
-- claims, their evidence pins, proposed ops, append-only decisions, the
-- default-branch reconcile cursor, and the per-org monthly model-call window.
-- Additive and idempotent: apply with `deploy/migrate.ts --apply` BEFORE
-- deploying the www revision that reads these tables. Names match the Drizzle
-- definitions in packages/shared/src/db/schema.ts exactly (schema-drift CI).

CREATE TABLE IF NOT EXISTS "knowledge_claim" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "repo_full_name" text NOT NULL,
  "page" text NOT NULL,
  "statement" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "state" text DEFAULT 'current' NOT NULL,
  "owner_user_id" text,
  "approved_by_user_id" text,
  "approved_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "knowledge_pin" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "claim_id" text NOT NULL,
  "uri" text NOT NULL,
  "hash" text NOT NULL,
  "observed_rev" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "knowledge_op" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "claim_id" text NOT NULL,
  "kind" text NOT NULL,
  "base_version" integer NOT NULL,
  "state" text DEFAULT 'proposed' NOT NULL,
  "proposal" jsonb NOT NULL,
  "merge_rev" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "knowledge_decision" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "op_id" text NOT NULL,
  "actor_user_id" text,
  "slack_user_id" text,
  "route" text NOT NULL,
  "choice" text NOT NULL,
  "decided_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "knowledge_cursor" (
  "organization_id" text NOT NULL,
  "repo_full_name" text NOT NULL,
  "default_branch" text NOT NULL,
  "last_sha" text,
  "observed_head_sha" text,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "knowledge_cursor_pk" PRIMARY KEY("organization_id","repo_full_name")
);

CREATE TABLE IF NOT EXISTS "knowledge_usage_window" (
  "organization_id" text NOT NULL,
  "window_start" timestamp NOT NULL,
  "cap_micro_usd" bigint NOT NULL,
  "reserved_micro_usd" bigint DEFAULT 0 NOT NULL,
  "spent_micro_usd" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "knowledge_usage_window_pk" PRIMARY KEY("organization_id","window_start")
);

DO $$ BEGIN
  ALTER TABLE "knowledge_claim"
    ADD CONSTRAINT "knowledge_claim_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "knowledge_claim"
    ADD CONSTRAINT "knowledge_claim_owner_user_id_user_id_fk"
    FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "knowledge_claim"
    ADD CONSTRAINT "knowledge_claim_approved_by_user_id_user_id_fk"
    FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "knowledge_pin"
    ADD CONSTRAINT "knowledge_pin_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "knowledge_pin"
    ADD CONSTRAINT "knowledge_pin_claim_id_knowledge_claim_id_fk"
    FOREIGN KEY ("claim_id") REFERENCES "public"."knowledge_claim"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "knowledge_op"
    ADD CONSTRAINT "knowledge_op_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "knowledge_op"
    ADD CONSTRAINT "knowledge_op_claim_id_knowledge_claim_id_fk"
    FOREIGN KEY ("claim_id") REFERENCES "public"."knowledge_claim"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "knowledge_decision"
    ADD CONSTRAINT "knowledge_decision_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "knowledge_decision"
    ADD CONSTRAINT "knowledge_decision_op_id_knowledge_op_id_fk"
    FOREIGN KEY ("op_id") REFERENCES "public"."knowledge_op"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "knowledge_decision"
    ADD CONSTRAINT "knowledge_decision_actor_user_id_user_id_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "knowledge_cursor"
    ADD CONSTRAINT "knowledge_cursor_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "knowledge_usage_window"
    ADD CONSTRAINT "knowledge_usage_window_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "knowledge_claim_org_repo_page_index"
  ON "knowledge_claim" USING btree ("organization_id","repo_full_name","page");
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_pin_claim_uri_unique"
  ON "knowledge_pin" USING btree ("claim_id","uri");
CREATE INDEX IF NOT EXISTS "knowledge_op_org_state_created_index"
  ON "knowledge_op" USING btree ("organization_id","state","created_at");
CREATE INDEX IF NOT EXISTS "knowledge_op_claim_index"
  ON "knowledge_op" USING btree ("claim_id");
CREATE INDEX IF NOT EXISTS "knowledge_decision_op_index"
  ON "knowledge_decision" USING btree ("op_id");

-- Post-migration verification:
--   \d knowledge_claim
--   SELECT count(*) FROM pg_constraint WHERE conrelid::regclass::text LIKE 'knowledge_%';
--   -- expect 6 PKs + 12 FKs
--   DATABASE_URL=... pnpm exec tsx deploy/assert-schema-ready.ts   -- exit 0
