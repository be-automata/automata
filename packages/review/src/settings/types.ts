/**
 * Settings bounded context — operator-mutable per-repository settings, stored
 * in SQLite (`data/repo-settings.db`) and edited from the web dashboard.
 * Distinct from WORKFLOW.md (operator-file-edited routing config, read-only to
 * the app) and from the secret store (encrypted values). Values here are plain
 * text — no encryption.
 */

import type { BlockTolerance } from '../review/severity-policy';

export type { BlockTolerance };
export { BLOCK_TOLERANCES, isBlockTolerance } from '../review/severity-policy';

/** One per-repo review-tolerance override row. `repo` is a lowercased 'owner/name' slug. */
export interface RepoReviewSetting {
  repo: string;
  blockTolerance: BlockTolerance;
  createdAt: string;
  updatedAt: string;
}

export interface RepoReviewSettingsStore {
  /** Lowercases `repo` before lookup. Returns undefined when no override exists. */
  get(repo: string): RepoReviewSetting | undefined;
  /** Upserts; lowercases `repo`. Returns the stored row. */
  set(repo: string, tolerance: BlockTolerance): RepoReviewSetting;
  /** Removes the override (repo reverts to env/default). No-op when absent. */
  remove(repo: string): void;
  list(): RepoReviewSetting[];
  close(): void;
}

/** One audit row per settings mutation. */
export interface RepoReviewSettingsAuditRecord {
  tokenId: string | null;
  repo: string;
  action: 'set' | 'delete';
  beforeValue: BlockTolerance | null;
  afterValue: BlockTolerance | null;
}

export interface RepoReviewSettingsAudit {
  record(entry: RepoReviewSettingsAuditRecord): void;
  close(): void;
}
