-- migrate:expand
--
-- #509: the delivery loop. One row per pull request an issue-delivery run
-- opened (delivery_pull_requests) and one per fix-cycle run
-- (delivery_fix_cycles), plus the per-repo mode knob on repo_review_settings
-- (nullable, NO default: NULL = inherit). Additive and idempotent: apply
-- BEFORE deploying the www revision that reads it (migrate.yml does this on
-- green main CI). Names and types match packages/shared/src/db/schema.ts
-- (deliveryPullRequests, deliveryFixCycles, deliveryLoopMode) exactly
-- (schema-drift CI).

ALTER TABLE "repo_review_settings" ADD COLUMN IF NOT EXISTS "delivery_loop_mode" text;

CREATE TABLE IF NOT EXISTS "delivery_pull_requests" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "repo_full_name" text NOT NULL,
  "pr_number" integer NOT NULL,
  "issue_number" integer NOT NULL,
  "head_ref" text NOT NULL,
  "base_ref" text NOT NULL,
  "delivery_thread_id" text NOT NULL,
  "automation_id" text NOT NULL,
  "phase" text NOT NULL,
  "head_sha" text,
  "head_seen_at" timestamp,
  "cycles_used" integer DEFAULT 0 NOT NULL,
  "ready_marked_head_sha" text,
  "ready_marked_at" timestamp,
  "merge_ready_head_sha" text,
  "merge_ready_comment_id" bigint,
  "stop_comment_id" bigint,
  "lease_until" timestamp,
  "evaluated_at" timestamp,
  "last_reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "delivery_fix_cycles" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "delivery_pr_id" text NOT NULL,
  "cycle_no" integer NOT NULL,
  "trigger_head_sha" text NOT NULL,
  "trigger" text NOT NULL,
  "review_id" bigint,
  "failing_checks" text[],
  "state" text NOT NULL,
  "thread_id" text,
  "result_head_sha" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "finished_at" timestamp
);

DO $$ BEGIN
  ALTER TABLE "delivery_pull_requests"
    ADD CONSTRAINT "delivery_pull_requests_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "delivery_pull_requests"
    ADD CONSTRAINT "delivery_pull_requests_delivery_thread_id_thread_id_fk"
    FOREIGN KEY ("delivery_thread_id") REFERENCES "public"."thread"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 64 characters: Postgres truncates it to 63, exactly as drizzle-kit push does.
DO $$ BEGIN
  ALTER TABLE "delivery_fix_cycles"
    ADD CONSTRAINT "delivery_fix_cycles_delivery_pr_id_delivery_pull_requests_id_fk"
    FOREIGN KEY ("delivery_pr_id") REFERENCES "public"."delivery_pull_requests"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "delivery_fix_cycles"
    ADD CONSTRAINT "delivery_fix_cycles_thread_id_thread_id_fk"
    FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "delivery_pull_requests_org_repo_pr_index"
  ON "delivery_pull_requests" USING btree ("organization_id","repo_full_name","pr_number");
CREATE INDEX IF NOT EXISTS "delivery_pull_requests_repo_head_index"
  ON "delivery_pull_requests" USING btree ("repo_full_name","head_sha");
CREATE INDEX IF NOT EXISTS "delivery_pull_requests_phase_evaluated_index"
  ON "delivery_pull_requests" USING btree ("phase","evaluated_at");
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_fix_cycles_pr_cycle_index"
  ON "delivery_fix_cycles" USING btree ("delivery_pr_id","cycle_no");
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_fix_cycles_pr_head_index"
  ON "delivery_fix_cycles" USING btree ("delivery_pr_id","trigger_head_sha");

-- Post-migration verification:
--   \d delivery_pull_requests
--   \d delivery_fix_cycles
--   DATABASE_URL=... pnpm exec tsx deploy/assert-schema-ready.ts   -- exit 0
