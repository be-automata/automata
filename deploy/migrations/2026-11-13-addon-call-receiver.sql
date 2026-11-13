-- migrate:expand
-- Add-on callback receiver (ADR-014 managed tier; add-on contract RAP / MCP Tasks).
-- addon_call: a call recorded before dispatch; the receiver accepts callbacks only for it.
-- addon_call_delivery: one row per callback delivery, create-only on (call_id, delivery_key),
-- so a retried or replayed delivery is never applied twice.
-- Additive and idempotent: apply BEFORE deploying the www revision that reads these tables
-- (migrate.yml does this on green main CI). Names and types match
-- packages/shared/src/db/schema.ts exactly (schema-drift CI).

CREATE TABLE IF NOT EXISTS "addon_call" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "thread_id" text,
  "transport" text NOT NULL,
  "group_id" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "addon_call" ADD CONSTRAINT "addon_call_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "addon_call" ADD CONSTRAINT "addon_call_thread_id_thread_id_fk"
    FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "addon_call_thread_id_index" ON "addon_call" USING btree ("thread_id");

CREATE TABLE IF NOT EXISTS "addon_call_delivery" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "call_id" text NOT NULL,
  "delivery_key" text NOT NULL,
  "kind" text NOT NULL,
  "body" jsonb NOT NULL,
  "final" boolean DEFAULT false NOT NULL,
  "received_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "addon_call_delivery" ADD CONSTRAINT "addon_call_delivery_call_id_addon_call_id_fk"
    FOREIGN KEY ("call_id") REFERENCES "public"."addon_call"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "addon_call_delivery_call_key_unique"
  ON "addon_call_delivery" USING btree ("call_id","delivery_key");

-- Post-migration verification:
--   \d addon_call
--   \d addon_call_delivery
--   pnpm exec tsx deploy/assert-schema-ready.ts
