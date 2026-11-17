/**
 * The migration ids deploy/migrations holds, in apply order. A new migration
 * file is added here once; the tests derive every count from this list.
 */
export const EXPECTED_MIGRATION_IDS = [
  "0000-baseline",
  "2026-08-04-better-auth-1.6-apikey-rename",
  "2026-09-02-165-retire-app-side-rows",
  "2026-10-08-organization-environment",
  "2026-10-14-environment-org-unique",
  "2026-10-19-knowledge-plane",
  "2026-10-22-queued-at",
  "2026-10-22-review-rerun",
  "2026-10-23-knowledge-org-controls",
  "2026-10-24-knowledge-op-fingerprint-index",
  "2026-10-25-knowledge-updated-at",
  "2026-10-26-delivery-loop",
  "2026-10-27-hatchet-tenant-binding",
  "2026-11-01-better-auth-1-7-columns",
  "2026-11-02-github-repo-org-binding",
  "2026-11-02-review-mode-on-update",
  "2026-11-05-knowledge-reconcile",
  "2026-11-10-execution-profile-cell-decision",
  "2026-11-10-execution-profile-seed-automata-box",
  "2026-11-13-addon-call-receiver",
  "2026-11-13-cell-broker-authority",
  "2026-11-14-org-cell-workflow-write",
  "2026-11-15-cell-step-allowed-ref",
  "2026-11-17-execution-profile-seed-opensandbox-runc",
  "2026-11-18-control-effects",
] as const;
