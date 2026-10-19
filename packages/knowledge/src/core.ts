/**
 * The fs-free surface of the knowledge engine: types, op keys and re-anchoring.
 *
 * Safe to import from the Cloudflare Worker (apps/www), which has no filesystem.
 * Everything that resolves evidence against a checkout (`resolve`, `pin`,
 * `checkPage`, `reconcile`, `applyDraft`) lives behind `@terragon/knowledge/node`
 * and runs on the worker, where the repository is on disk.
 *
 * Only `export type` may name ./claims here: type-only exports are erased at
 * build time, so the Worker bundle never pulls claims.ts and its `node:fs`.
 * core.test.ts walks this file's runtime imports and fails if one reaches a
 * Node-only module.
 */
export type {
  Claim,
  ClaimReport,
  ClaimStatus,
  Draft,
  DraftOp,
  DraftOpKind,
  EvidencePin,
  EvidenceStatus,
  MissingCode,
  PageReport,
  ReconcileDiff,
  ReconcileOptions,
  Resolved,
  Sidecar,
  UpdateRequest,
  UpdateResult,
  Updater,
} from "./claims";
export * from "./op-key";
export * from "./reanchor";
