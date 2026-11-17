-- migrate:expand
-- The control-plane effect ledger (#652): effects that leave Automata (a Drive upload, a run
-- summary post) run once. A row is written as an intent (done_at NULL) before the effect and
-- completed after it; a redelivery with an intent left behind looks for the effect's marker
-- before applying. cell_effect is not reused: it requires a cell step, and the control plane has none.
-- Additive and idempotent: apply BEFORE deploying the www/worker revision that reads this table
-- (migrate.yml does this on green main CI). Names and types match
-- packages/shared/src/db/schema.ts exactly (schema-drift CI).

CREATE TABLE IF NOT EXISTS "control_effects" (
  "key" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "mission" text NOT NULL,
  "step" text NOT NULL,
  "effect" text NOT NULL,
  "output_digest" text NOT NULL,
  "intent_at" timestamp DEFAULT now() NOT NULL,
  "done_at" timestamp,
  "reconciled" boolean DEFAULT false NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "control_effects" ADD CONSTRAINT "control_effects_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "control_effects_organization_id_index" ON "control_effects" USING btree ("organization_id");

-- Post-migration verification:
--   \d control_effects
--   pnpm exec tsx deploy/assert-schema-ready.ts
