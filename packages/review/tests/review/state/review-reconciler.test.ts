/**
 * review-reconciler — the pure post-run no-dup decision (ADR-036 interim).
 * node:test + node:assert/strict.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  reconcileReviews,
  type ReconcilableReview,
} from "../../../src/review/state/review-reconciler";

const BOT = "automata-ai-bot[bot]";

function rv(
  id: number,
  state: string,
  submittedAt: string,
  commitId = "sha1",
  login = BOT,
): ReconcilableReview {
  return { id, state, submittedAt, commitId, login };
}

describe("reconcileReviews", () => {
  test("S1 shape: two same commit+verdict reviews → keep EARLIEST, dismiss the later dup", () => {
    const result = reconcileReviews({
      reviews: [
        rv(823, "CHANGES_REQUESTED", "2026-07-18T09:33:58Z"),
        rv(904, "CHANGES_REQUESTED", "2026-07-18T09:34:03Z"),
      ],
      botLogin: BOT,
    });
    assert.equal(result.keepId, 823); // earliest
    assert.equal(result.toDismiss.length, 1);
    assert.equal(result.toDismiss[0].id, 904);
    assert.match(result.toDismiss[0].reason, /Duplicate of review 823/);
    assert.equal(result.actionableCount, 2);
  });

  test("verdict upgrade: CR over prior APPROVE at same commit → keep CR, dismiss (supersede) the APPROVE", () => {
    const result = reconcileReviews({
      reviews: [
        rv(1, "APPROVED", "2026-07-18T09:00:00Z"),
        rv(2, "CHANGES_REQUESTED", "2026-07-18T09:05:00Z"),
      ],
      botLogin: BOT,
    });
    assert.equal(result.keepId, 2); // newest verdict
    assert.deepEqual(
      result.toDismiss.map((d) => d.id),
      [1],
    );
    assert.match(result.toDismiss[0].reason, /Superseded/);
  });

  test("approve after CR at same commit → keep APPROVE, dismiss the CR (approve-unblock)", () => {
    const result = reconcileReviews({
      reviews: [
        rv(1, "CHANGES_REQUESTED", "2026-07-18T09:00:00Z"),
        rv(2, "APPROVED", "2026-07-18T09:05:00Z"),
      ],
      botLogin: BOT,
    });
    assert.equal(result.keepId, 2);
    assert.deepEqual(
      result.toDismiss.map((d) => d.id),
      [1],
    );
  });

  test("same verdict at a newer commit → keep the HEAD review, dismiss the stale older-commit CR", () => {
    const result = reconcileReviews({
      reviews: [
        rv(1, "CHANGES_REQUESTED", "2026-07-18T09:00:00Z", "old-sha"),
        rv(2, "CHANGES_REQUESTED", "2026-07-18T09:05:00Z", "head-sha"),
      ],
      botLogin: BOT,
    });
    assert.equal(result.keepId, 2); // HEAD
    assert.deepEqual(
      result.toDismiss.map((d) => d.id),
      [1],
    );
    assert.match(result.toDismiss[0].reason, /Superseded/);
  });

  test("COMMENTED reviews are counted and NEVER dismissed (GitHub 422s)", () => {
    const result = reconcileReviews({
      reviews: [
        rv(1, "CHANGES_REQUESTED", "2026-07-18T09:00:00Z"),
        rv(2, "COMMENTED", "2026-07-18T09:01:00Z"),
        rv(3, "COMMENTED", "2026-07-18T09:02:00Z"),
      ],
      botLogin: BOT,
    });
    assert.equal(result.keepId, 1);
    assert.equal(result.toDismiss.length, 0); // single actionable CR, nothing to dismiss
    assert.equal(result.commentedSkipped, 2);
  });

  test("zero-dup: one bot review → no-op", () => {
    const result = reconcileReviews({
      reviews: [rv(1, "CHANGES_REQUESTED", "2026-07-18T09:00:00Z")],
      botLogin: BOT,
    });
    assert.equal(result.keepId, 1);
    assert.equal(result.toDismiss.length, 0);
  });

  test("no bot reviews → no-op (keepId null)", () => {
    const result = reconcileReviews({
      reviews: [rv(1, "CHANGES_REQUESTED", "2026-07-18T09:00:00Z", "sha1", "someone-else")],
      botLogin: BOT,
    });
    assert.equal(result.keepId, null);
    assert.equal(result.toDismiss.length, 0);
    assert.equal(result.actionableCount, 0);
  });

  test("already-dismissed reviews (state DISMISSED) are excluded → idempotent no-op", () => {
    const result = reconcileReviews({
      reviews: [
        rv(1, "CHANGES_REQUESTED", "2026-07-18T09:00:00Z"),
        rv(2, "DISMISSED", "2026-07-18T09:05:00Z"),
      ],
      botLogin: BOT,
    });
    assert.equal(result.keepId, 1);
    assert.equal(result.toDismiss.length, 0);
  });

  test("dismiss-set never includes the keeper (safety)", () => {
    const result = reconcileReviews({
      reviews: [
        rv(1, "CHANGES_REQUESTED", "2026-07-18T09:00:00Z"),
        rv(2, "CHANGES_REQUESTED", "2026-07-18T09:01:00Z"),
        rv(3, "CHANGES_REQUESTED", "2026-07-18T09:02:00Z"),
      ],
      botLogin: BOT,
    });
    assert.equal(result.keepId, 1);
    assert.ok(!result.toDismiss.some((d) => d.id === result.keepId));
    assert.equal(result.toDismiss.length, 2);
  });
});
