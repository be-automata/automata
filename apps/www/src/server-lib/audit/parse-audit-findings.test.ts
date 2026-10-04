import { describe, expect, it } from "vitest";

import {
  ECHO_AFTER_LEAD,
  LEAD_FINDING,
  LEAD_TEXT,
  REPO,
  fence,
  makeBlock,
  makeFinding,
} from "./__fixtures__/audit-terminal-messages";
import {
  hasTaggedAuditFindingsOpener,
  parseAuditFindings,
  selectAuditTerminalText,
} from "./parse-audit-findings";

const parse = (text: string) =>
  parseAuditFindings(text, { repoFullName: REPO });

function mustOk(text: string) {
  const result = parse(text);
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result;
}

describe("parseAuditFindings", () => {
  it("(a) parses a lead tagged block and fingerprints findings", () => {
    const { block, dropped } = mustOk(LEAD_TEXT);
    expect(block.findings).toHaveLength(1);
    expect(block.findings[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(block.findings[0]!.subject).toBe("config/prod.pem");
    expect(Object.values(dropped).every((n) => n === 0)).toBe(true);
  });

  it("(b) selects the lead text, not a later sub-agent echo", () => {
    expect(selectAuditTerminalText(ECHO_AFTER_LEAD)).toBe(LEAD_TEXT);
    expect(selectAuditTerminalText(null)).toBe("");
  });

  it("(c) the last of two tagged blocks wins", () => {
    const second = makeFinding({ subject: "second.pem" });
    const text =
      fence(makeBlock([LEAD_FINDING])) + "\n" + fence(makeBlock([second]));
    expect(mustOk(text).block.findings[0]!.subject).toBe("second.pem");
  });

  it("(d) an unclosed last block fails closed with no fallback", () => {
    const text =
      fence(makeBlock([LEAD_FINDING])) +
      "\n```json audit-findings\n" +
      JSON.stringify(makeBlock([]));
    const result = parse(text);
    expect(result.ok).toBe(false);
  });

  it("(e) an untagged json block is rejected and names the missing tag", () => {
    const result = parse(fence(makeBlock([LEAD_FINDING]), "json"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("audit-findings");
  });

  it("(f) drops unknown rules and rules from another audit", () => {
    const text = fence(
      makeBlock([
        makeFinding({ rule: "foo.bar" }),
        makeFinding({ subject: "kept.pem" }),
      ]),
    );
    const { block, dropped } = mustOk(text);
    expect(dropped.unknown_rule).toBe(1);
    expect(block.findings).toHaveLength(1);
    // No second audit is registered, so rule_audit_mismatch is exercised via
    // the counter shape only.
    expect(dropped.rule_audit_mismatch).toBe(0);
  });

  it("(g) caps at 25 keeping the highest severities", () => {
    const lows = Array.from({ length: 22 }, (_, i) =>
      makeFinding({ severity: "low", subject: `low-${i}.pem` }),
    );
    const highs = Array.from({ length: 8 }, (_, i) =>
      makeFinding({ severity: "high", subject: `high-${i}.pem` }),
    );
    const { block, dropped } = mustOk(fence(makeBlock([...lows, ...highs])));
    expect(block.findings).toHaveLength(25);
    expect(dropped.over_cap).toBe(5);
    expect(block.findings.filter((f) => f.severity === "high")).toHaveLength(8);
  });

  it("(h) clips long fields and tolerates bad file paths", () => {
    const files = [
      "../escape",
      ...Array.from({ length: 14 }, (_, i) => `src/f${i}.ts`),
    ];
    const { block } = mustOk(
      fence(
        makeBlock([
          makeFinding({
            title: "t".repeat(500),
            plan: "p".repeat(7000),
            acceptance: "a".repeat(2000),
            files,
          }),
        ]),
      ),
    );
    const f = block.findings[0]!;
    expect(f.title).toHaveLength(140);
    expect(f.plan).toHaveLength(6000);
    expect(f.acceptance).toHaveLength(1500);
    expect(f.files).toHaveLength(10);
    expect(f.files).not.toContain("../escape");
  });

  it("(i) a mid-line mention of the tag is not an opener", () => {
    const text = 'see ```json audit-findings\n{"x":1}\n```';
    expect(hasTaggedAuditFindingsOpener(text)).toBe(false);
    expect(parse(text).ok).toBe(false);
  });

  it("(j) carries complete:false and drops unknown sections", () => {
    const text = fence(
      makeBlock([LEAD_FINDING], {
        complete: false,
        sections: [
          { id: "sensitive-files", name: "Sensitive files" },
          { id: "made-up", name: "Nope" },
        ],
      }),
    );
    const { block, dropped } = mustOk(text);
    expect(block.complete).toBe(false);
    expect(block.sections).toHaveLength(1);
    expect(dropped.bad_section).toBe(1);
  });

  it("(k) invalid JSON fails without echoing the payload", () => {
    const result = parse(fence("{ SECRET-PAYLOAD not json"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain("SECRET-PAYLOAD");
  });

  it("drops invalid subjects and keys, and duplicate fingerprints", () => {
    const text = fence(
      makeBlock([
        makeFinding({ subject: "/etc/passwd" }),
        makeFinding({ subject: "a.pem", key: "BAD KEY" }),
        makeFinding({ subject: "dup.pem" }),
        makeFinding({ subject: "./dup.pem:3", title: "reworded" }),
      ]),
    );
    const { block, dropped } = mustOk(text);
    expect(dropped.bad_subject).toBe(2);
    expect(dropped.schema).toBe(1);
    expect(block.findings).toHaveLength(1);
  });

  it("rejects a wrong envelope", () => {
    expect(parse(fence(makeBlock([], { schemaVersion: 2 }))).ok).toBe(false);
    expect(parse(fence(makeBlock([], { audit: "nope" }))).ok).toBe(false);
  });
});
