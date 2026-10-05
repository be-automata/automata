import { describe, expect, it } from "vitest";

import {
  isAuditFindingsStamp,
  isAuditFixAction,
  isAuditFixStamp,
  skillNameIs,
} from "./review-skill";

function stamp(skillName: string) {
  return {
    type: "automation-skill" as const,
    skillName,
    contentSha: "sha",
    source: "db-version",
  };
}

describe("self-heal skill identity", () => {
  it("compares skill names trimmed and case-insensitively", () => {
    expect(skillNameIs(" Audit-Fix ", "audit-fix")).toBe(true);
    expect(skillNameIs("audit-fixes", "audit-fix")).toBe(false);
  });

  it("matches the audit-fix action and stamps the same way", () => {
    expect(
      isAuditFixAction({
        type: "skill_message",
        config: { skillName: "AUDIT-FIX" },
      } as Parameters<typeof isAuditFixAction>[0]),
    ).toBe(true);
    expect(isAuditFixAction(undefined)).toBe(false);
    expect(isAuditFixStamp(stamp(" audit-fix"))).toBe(true);
    expect(isAuditFixStamp(stamp("audit-findings"))).toBe(false);
    expect(isAuditFindingsStamp(stamp("Audit-Findings"))).toBe(true);
    expect(isAuditFindingsStamp(null)).toBe(false);
  });
});
