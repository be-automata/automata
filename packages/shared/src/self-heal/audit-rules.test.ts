import { describe, expect, it } from "vitest";

import {
  AUDIT_CHECK_KINDS,
  AUDIT_IDS,
  AUDIT_RULES,
  AUDIT_SECTIONS,
  CLOSE_CONSECUTIVE_PASSES,
  CONSENSUS_QUORUM,
  CONSENSUS_WINDOW,
  MAX_FINDINGS_PER_RUN,
  getAuditRule,
} from "./audit-rules";

describe("audit rule vocabulary", () => {
  it("places every rule in a declared section of its audit", () => {
    for (const rule of AUDIT_RULES) {
      expect(AUDIT_IDS).toContain(rule.audit);
      expect(AUDIT_SECTIONS[rule.audit]).toContain(rule.section);
    }
  });

  it("has unique ids", () => {
    const ids = AUDIT_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("makes checkKind script iff check is non-null, and checks are known", () => {
    for (const rule of AUDIT_RULES) {
      expect(rule.checkKind === "script").toBe(rule.check !== null);
      if (rule.check !== null) {
        expect(AUDIT_CHECK_KINDS).toContain(rule.check);
      }
    }
  });

  it("uses every check kind at least once", () => {
    const used = new Set(AUDIT_RULES.map((r) => r.check));
    for (const kind of AUDIT_CHECK_KINDS) {
      expect(used.has(kind)).toBe(true);
    }
  });

  it("marks secret and sensitive-file rules not public safe", () => {
    expect(getAuditRule("secret.hardcoded")?.publicSafe).toBe(false);
    expect(getAuditRule("files.sensitive-committed")?.publicSafe).toBe(false);
    expect(getAuditRule("dep.vulnerable")?.publicSafe).toBe(true);
  });

  it("returns undefined for an unknown rule", () => {
    expect(getAuditRule("nope")).toBeUndefined();
  });

  it("exposes the consensus constants", () => {
    expect(CONSENSUS_WINDOW).toBe(3);
    expect(CONSENSUS_QUORUM).toBe(2);
    expect(CLOSE_CONSECUTIVE_PASSES).toBe(2);
    expect(MAX_FINDINGS_PER_RUN).toBe(25);
  });
});
