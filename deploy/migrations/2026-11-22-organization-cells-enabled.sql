-- migrate:expand
--
-- #708: the per-org cells gate. Cells run for a run only when OpenSandbox is configured,
-- the owner's `opensandboxCells` flag is on AND the run's org has cells_enabled. Additive,
-- default false (no org gets cells until an admin switches it on), no backfill. Apply
-- BEFORE deploying the www revision that reads it (migrate.yml does this on green main
-- CI). Names and types match packages/shared/src/db/schema.ts (organization.cellsEnabled).

ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "cells_enabled" boolean DEFAULT false NOT NULL;

-- Post-migration verification:
--   \d organization
--   pnpm exec tsx deploy/assert-schema-ready.ts
