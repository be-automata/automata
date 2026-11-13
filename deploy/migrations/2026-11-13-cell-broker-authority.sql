-- migrate:expand
-- Durable authority for remote cells (ADR-014, "Remote cells cannot rely on the worker heap").
-- cell_step: one row per run step; the current attempt holds the lease and older attempts are
-- fenced; the effect budget is per step; revoked_through records the sweep's revocation. cell_bearer:
-- per-attempt bearers (sha256 only), TTL bounded by the step timeout. cell_effect: the create-only effect ledger.
-- Additive and idempotent: apply BEFORE deploying the www revision that reads these tables
-- (migrate.yml does this on green main CI). Names and types match
-- packages/shared/src/db/schema.ts exactly (schema-drift CI).

CREATE TABLE IF NOT EXISTS "cell_step" (
  "step_key" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "current_attempt" integer NOT NULL,
  "step_timeout_ms" integer NOT NULL,
  "effect_budget" integer,
  "effects_used" integer DEFAULT 0 NOT NULL,
  "revoked_through" integer,
  "done_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "cell_step" ADD CONSTRAINT "cell_step_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cell_step" ADD CONSTRAINT "cell_step_thread_id_thread_id_fk"
    FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "cell_step_thread_id_index" ON "cell_step" USING btree ("thread_id");
CREATE INDEX IF NOT EXISTS "cell_step_organization_id_index" ON "cell_step" USING btree ("organization_id");

CREATE TABLE IF NOT EXISTS "cell_bearer" (
  "token_hash" text PRIMARY KEY NOT NULL,
  "step_key" text NOT NULL,
  "attempt" integer NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "cell_bearer" ADD CONSTRAINT "cell_bearer_step_key_cell_step_step_key_fk"
    FOREIGN KEY ("step_key") REFERENCES "public"."cell_step"("step_key") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "cell_bearer_step_attempt_index" ON "cell_bearer" USING btree ("step_key","attempt");

CREATE TABLE IF NOT EXISTS "cell_effect" (
  "step_key" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "attempt" integer NOT NULL,
  "result" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "cell_effect_pk" PRIMARY KEY("step_key","idempotency_key")
);

DO $$ BEGIN
  ALTER TABLE "cell_effect" ADD CONSTRAINT "cell_effect_step_key_cell_step_step_key_fk"
    FOREIGN KEY ("step_key") REFERENCES "public"."cell_step"("step_key") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Post-migration verification:
--   \d cell_step
--   \d cell_bearer
--   \d cell_effect
--   pnpm exec tsx deploy/assert-schema-ready.ts
