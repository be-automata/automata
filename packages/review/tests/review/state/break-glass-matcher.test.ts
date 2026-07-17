/**
 * Unit tests for createBreakGlassMatcher.
 *
 * Covers FR-9, AC-7, AC-8, AC-9, EC-12, EC-18.
 *
 * Grammar (case-sensitive, anchored start-and-end-of-body):
 *   ^break glass(:\s*(.+))?$
 * Reason text truncated at 500 chars.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBreakGlassMatcher } from "../../../src/review/state/break-glass-matcher";

const matcher = createBreakGlassMatcher();

describe("breakGlassMatcher.match", () => {
  it('matches bare "break glass" with reason=null', () => {
    const r = matcher.match("break glass");
    assert.equal(r.matched, true);
    assert.equal(r.reason, null);
  });

  it('AC-7: matches "break glass: hotfix" with reason="hotfix"', () => {
    const r = matcher.match("break glass: hotfix");
    assert.equal(r.matched, true);
    assert.equal(r.reason, "hotfix");
  });

  it('matches "break glass:hotfix" (no leading whitespace after colon)', () => {
    const r = matcher.match("break glass:hotfix");
    assert.equal(r.matched, true);
    assert.equal(r.reason, "hotfix");
  });

  it('matches "break glass:    hotfix" (multiple spaces)', () => {
    const r = matcher.match("break glass:    hotfix");
    assert.equal(r.matched, true);
    assert.equal(r.reason, "hotfix");
  });

  it('does NOT match "break glass:" with no reason text', () => {
    const r = matcher.match("break glass:");
    assert.equal(r.matched, false);
  });

  it('does NOT match "break glass:    " (whitespace-only reason)', () => {
    const r = matcher.match("break glass:    ");
    assert.equal(r.matched, false);
  });

  it('AC-9: does NOT match wrong case "Break Glass"', () => {
    const r = matcher.match("Break Glass");
    assert.equal(r.matched, false);
  });

  it('AC-9: does NOT match "BREAK GLASS"', () => {
    const r = matcher.match("BREAK GLASS");
    assert.equal(r.matched, false);
  });

  it('AC-9: does NOT match when not at start "please break glass for me"', () => {
    const r = matcher.match("please break glass for me");
    assert.equal(r.matched, false);
  });

  it('AC-9: does NOT match markdown-prefixed "# break glass: yolo"', () => {
    const r = matcher.match("# break glass: yolo");
    assert.equal(r.matched, false);
  });

  it('does NOT match leading whitespace " break glass"', () => {
    const r = matcher.match(" break glass");
    assert.equal(r.matched, false);
  });

  it("EC-12: strips trailing \\n", () => {
    const r = matcher.match("break glass: hotfix\n");
    assert.equal(r.matched, true);
    assert.equal(r.reason, "hotfix");
  });

  it("EC-12: strips trailing \\r\\n (CRLF from GitHub web UI)", () => {
    const r = matcher.match("break glass: hotfix\r\n");
    assert.equal(r.matched, true);
    assert.equal(r.reason, "hotfix");
  });

  it("FR-9: truncates reason text to 500 chars", () => {
    const longReason = "a".repeat(600);
    const r = matcher.match(`break glass: ${longReason}`);
    assert.equal(r.matched, true);
    assert.equal(r.reason!.length, 500);
    assert.equal(r.reason, "a".repeat(500));
  });

  it("FR-9: 500-char reason is preserved exactly", () => {
    const exactReason = "a".repeat(500);
    const r = matcher.match(`break glass: ${exactReason}`);
    assert.equal(r.matched, true);
    assert.equal(r.reason!.length, 500);
  });

  it('does NOT match "break glass extra" (no colon, has trailing junk)', () => {
    const r = matcher.match("break glass extra");
    assert.equal(r.matched, false);
  });

  it("handles empty body", () => {
    const r = matcher.match("");
    assert.equal(r.matched, false);
  });

  it("preserves reason verbatim including markdown / special chars (EC-18)", () => {
    const r = matcher.match(
      "break glass: # heading [link](javascript:alert(1))",
    );
    assert.equal(r.matched, true);
    assert.equal(r.reason, "# heading [link](javascript:alert(1))");
  });

  it("does NOT match multi-line bodies that are not single-line break-glass", () => {
    // The grammar matches the WHOLE body. A body with content after a newline fails.
    const r = matcher.match("break glass\nfollow-up text");
    assert.equal(r.matched, false);
  });
});
