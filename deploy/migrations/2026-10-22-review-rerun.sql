-- migrate:expand
--
-- #107: the no-verdict re-run ledger. A review run that failed before it
-- produced a verdict (an infra failure) is re-dispatched for the same PR and
-- head up to twice, with backoff, before the PR gets the no-verdict notice.
-- One row per scheduled re-run. Additive and idempotent: apply BEFORE
-- deploying the www revision that reads it (migrate.yml does this on green
-- main CI). Names and types match packages/shared/src/db/schema.ts
-- (reviewRerun) exactly (schema-drift CI).

CREATE TABLE IF NOT EXISTS "review_rerun" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pr_key" text NOT NULL,
  "head_sha" text NOT NULL,
  "attempt" integer NOT NULL,
  "failed_thread_id" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "due_at" timestamp NOT NULL,
  "outcome_reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "review_rerun"
    ADD CONSTRAINT "review_rerun_failed_thread_id_thread_id_fk"
    FOREIGN KEY ("failed_thread_id") REFERENCES "public"."thread"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "review_rerun_pr_key_sha_attempt_index"
  ON "review_rerun" USING btree ("pr_key","head_sha","attempt");
CREATE UNIQUE INDEX IF NOT EXISTS "review_rerun_failed_thread_index"
  ON "review_rerun" USING btree ("failed_thread_id");
CREATE INDEX IF NOT EXISTS "review_rerun_state_due_index"
  ON "review_rerun" USING btree ("state","due_at");

-- Post-migration verification:
--   \d review_rerun
--   DATABASE_URL=... pnpm exec tsx deploy/assert-schema-ready.ts   -- exit 0
