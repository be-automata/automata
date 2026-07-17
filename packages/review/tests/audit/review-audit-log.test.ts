/**
 * Integration tests for createReviewAuditLog (real SQLite via openDatabase).
 *
 * Covers FR-12 (six event types persist with correct payload shape) and
 * AC-11 (exact event-count invariants per pass).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReviewAuditLog,
  type ReviewAuditLog,
  type ReviewAuditEventType,
} from "../../src/audit/review-audit-log";

const ALL_TYPES: ReviewAuditEventType[] = [
  "review.started",
  "review.completed",
  "review.finding_lifecycle",
  "review.dismissed",
  "review.break_glass",
  "review.token_usage",
];

describe("createReviewAuditLog", () => {
  let tmp: string;
  let log: ReviewAuditLog;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "review-audit-"));
    log = createReviewAuditLog(join(tmp, "review-audit.db"));
  });

  afterEach(async () => {
    await log.flush();
    log.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("persists each of the six event types", async () => {
    for (const type of ALL_TYPES) {
      log.emit({
        type,
        repo: "a/b",
        prNumber: 1,
        payload: { hello: "world", type },
      });
    }
    await log.flush();
    const rows = log.list();
    assert.equal(rows.length, ALL_TYPES.length);
    const seen = new Set(rows.map((r) => r.type));
    for (const type of ALL_TYPES)
      assert.ok(seen.has(type), `missing type ${type}`);
  });

  it("AC-11: persists payload as JSON and round-trips fields", async () => {
    log.emit({
      type: "review.finding_lifecycle",
      repo: "a/b",
      prNumber: 7,
      findingId: "fp-x",
      payload: { before: "active", after: "fixed", severity: "warning" },
    });
    await log.flush();
    const rows = log.list({ repo: "a/b", prNumber: 7 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].findingId, "fp-x");
    assert.deepEqual(rows[0].payload, {
      before: "active",
      after: "fixed",
      severity: "warning",
    });
  });

  it("emit() returns synchronously (NFR-2)", () => {
    // Should not return a Promise.
    const r = log.emit({
      type: "review.started",
      repo: "a/b",
      prNumber: 1,
      payload: { sha: "abc" },
    });
    assert.equal(r as unknown as undefined, undefined);
  });

  it("list() filters by repo + prNumber", async () => {
    log.emit({ type: "review.started", repo: "a/b", prNumber: 1, payload: {} });
    log.emit({ type: "review.started", repo: "c/d", prNumber: 2, payload: {} });
    log.emit({ type: "review.started", repo: "a/b", prNumber: 3, payload: {} });
    await log.flush();
    const rows = log.list({ repo: "a/b", prNumber: 1 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].repo, "a/b");
    assert.equal(rows[0].prNumber, 1);
  });

  it("list() filters by type", async () => {
    log.emit({ type: "review.started", repo: "a/b", prNumber: 1, payload: {} });
    log.emit({
      type: "review.completed",
      repo: "a/b",
      prNumber: 1,
      payload: {},
    });
    await log.flush();
    const rows = log.list({ type: "review.completed" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, "review.completed");
  });

  it("count() returns total row count", async () => {
    for (let i = 0; i < 5; i++) {
      log.emit({
        type: "review.started",
        repo: "a/b",
        prNumber: i,
        payload: {},
      });
    }
    await log.flush();
    assert.equal(log.count(), 5);
  });

  it("NFR-7 / AC-16: redacts secret-shaped strings inside payload", async () => {
    log.emit({
      type: "review.token_usage",
      repo: "a/b",
      prNumber: 1,
      payload: {
        token: "ghp_" + "x".repeat(36),
        nested: { auth: "AKIA" + "A".repeat(16) },
        safe: "hello",
      },
    });
    await log.flush();
    const row = log.list()[0];
    assert.equal((row.payload as { token: string }).token, "<REDACTED>");
    assert.equal((row.payload.nested as { auth: string }).auth, "<REDACTED>");
    assert.equal((row.payload as { safe: string }).safe, "hello");
  });

  it("captures actor / auditId on break_glass entries", async () => {
    log.emit({
      type: "review.break_glass",
      repo: "a/b",
      prNumber: 1,
      actor: "alice",
      auditId: "audit-abc",
      payload: { outcome: "dismissed", permission: "admin" },
    });
    await log.flush();
    const row = log.list()[0];
    assert.equal(row.actor, "alice");
    assert.equal(row.auditId, "audit-abc");
  });

  it("persists ISO-8601 timestamp", async () => {
    log.emit({ type: "review.started", repo: "a/b", prNumber: 1, payload: {} });
    await log.flush();
    const row = log.list()[0];
    assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("AC-11: single review pass produces correct event counts", async () => {
    // 1 started + 1 completed + 3 finding_lifecycle + 1 token_usage
    log.emit({ type: "review.started", repo: "a/b", prNumber: 1, payload: {} });
    log.emit({
      type: "review.token_usage",
      repo: "a/b",
      prNumber: 1,
      payload: {},
    });
    for (let i = 0; i < 3; i++) {
      log.emit({
        type: "review.finding_lifecycle",
        repo: "a/b",
        prNumber: 1,
        findingId: `fp-${i}`,
        payload: { before: "active", after: "fixed" },
      });
    }
    log.emit({
      type: "review.completed",
      repo: "a/b",
      prNumber: 1,
      payload: {},
    });
    await log.flush();

    const rows = log.list({ repo: "a/b", prNumber: 1 });
    const byType = new Map<string, number>();
    for (const r of rows) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
    assert.equal(byType.get("review.started"), 1);
    assert.equal(byType.get("review.completed"), 1);
    assert.equal(byType.get("review.finding_lifecycle"), 3);
    assert.equal(byType.get("review.token_usage"), 1);
  });
});
