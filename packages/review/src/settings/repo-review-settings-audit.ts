/**
 * Append-only audit log for repo review-settings mutations (same pattern as
 * secret-audit.ts). Lives in the SAME db file as the settings store so one
 * REPO_SETTINGS_DB_PATH override moves both.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDatabase } from "../shared/sqlite";
import type {
  RepoReviewSettingsAudit,
  RepoReviewSettingsAuditRecord,
} from "./types";

export function createRepoReviewSettingsAudit(
  dbPath: string,
): RepoReviewSettingsAudit {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = openDatabase(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS repo_review_settings_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT,
      repo TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('set', 'delete')),
      before_value TEXT,
      after_value TEXT,
      at TEXT NOT NULL
    )
  `);

  const insertStmt = db.prepare(`
    INSERT INTO repo_review_settings_audit (token_id, repo, action, before_value, after_value, at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  return {
    record(entry: RepoReviewSettingsAuditRecord): void {
      insertStmt.run(
        entry.tokenId,
        entry.repo.toLowerCase(),
        entry.action,
        entry.beforeValue,
        entry.afterValue,
        new Date().toISOString(),
      );
    },

    close(): void {
      db.close();
    },
  };
}
