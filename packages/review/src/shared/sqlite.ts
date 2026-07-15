/**
 * Shared SQLite opener for all node:sqlite DatabaseSync callers.
 *
 * Applies WAL mode + busy_timeout so concurrent readers don't block the writer
 * and SQLITE_BUSY is handled internally by SQLite's sleep-and-retry before it
 * surfaces as an exception. synchronous=NORMAL is the idiomatic WAL pairing.
 */

import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}
