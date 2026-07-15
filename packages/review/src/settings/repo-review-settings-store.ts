/**
 * Persistent per-repo review settings using Node.js built-in SQLite.
 *
 * Stores the operator-chosen REQUESTED_CHANGES tolerance per repository.
 * Uses node:sqlite DatabaseSync (same pattern as secret-persistence.ts).
 * Repo slugs are lowercased on BOTH write and read — GitHub slugs are
 * case-insensitive but webhook/WORKFLOW.md casing varies, and a
 * case-mismatched override must never silently stop matching.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase } from '../shared/sqlite';
import type { BlockTolerance, RepoReviewSetting, RepoReviewSettingsStore } from './types';

export function createRepoReviewSettingsStore(dbPath: string): RepoReviewSettingsStore {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = openDatabase(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS repo_review_settings (
      repo TEXT PRIMARY KEY,
      block_tolerance TEXT NOT NULL CHECK (block_tolerance IN ('info', 'warning', 'error')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO repo_review_settings (repo, block_tolerance, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(repo) DO UPDATE SET
      block_tolerance = excluded.block_tolerance,
      updated_at = excluded.updated_at
  `);

  const getStmt = db.prepare(
    'SELECT repo, block_tolerance, created_at, updated_at FROM repo_review_settings WHERE repo = ?',
  );

  const removeStmt = db.prepare('DELETE FROM repo_review_settings WHERE repo = ?');

  const listStmt = db.prepare(
    'SELECT repo, block_tolerance, created_at, updated_at FROM repo_review_settings ORDER BY repo',
  );

  function toSetting(row: Record<string, unknown>): RepoReviewSetting {
    return {
      repo: row.repo as string,
      blockTolerance: row.block_tolerance as BlockTolerance,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  return {
    get(repo: string): RepoReviewSetting | undefined {
      const row = getStmt.get(repo.toLowerCase()) as Record<string, unknown> | undefined;
      return row ? toSetting(row) : undefined;
    },

    set(repo: string, tolerance: BlockTolerance): RepoReviewSetting {
      const slug = repo.toLowerCase();
      const now = new Date().toISOString();
      upsertStmt.run(slug, tolerance, now, now);
      // Re-read (one PK lookup on a rare operator write): ON CONFLICT keeps
      // the original created_at, which a constructed return would misreport.
      const row = getStmt.get(slug) as Record<string, unknown>;
      return toSetting(row);
    },

    remove(repo: string): void {
      removeStmt.run(repo.toLowerCase());
    },

    list(): RepoReviewSetting[] {
      const rows = listStmt.all() as Record<string, unknown>[];
      return rows.map(toSetting);
    },

    close(): void {
      db.close();
    },
  };
}
