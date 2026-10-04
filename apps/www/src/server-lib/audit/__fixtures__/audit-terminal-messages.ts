import type { DBMessage } from "@terragon/shared/db/db-message";

/**
 * Terminal-message fixtures for the audit lane: a lead that emitted its tagged
 * block, then a sub-agent that echoed a (different) tagged block after it.
 */

export const REPO = "acme/widgets";

export interface FixtureFinding {
  rule: string;
  subject: string;
  key?: string;
  severity: "low" | "medium" | "high";
  section: string;
  title: string;
  files?: unknown[];
  plan: string;
  acceptance: string;
  effort: "S" | "M" | "L";
}

export function makeFinding(
  overrides: Partial<FixtureFinding> = {},
): FixtureFinding {
  return {
    rule: "files.sensitive-committed",
    subject: "config/prod.pem",
    severity: "high",
    section: "sensitive-files",
    title: "Private key committed",
    files: ["config/prod.pem"],
    plan: "Remove the file and rotate the key.",
    acceptance: "The file is untracked.",
    effort: "S",
    ...overrides,
  };
}

export function makeBlock(
  findings: unknown[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "audit-findings",
    schemaVersion: 1,
    audit: "security-audit",
    complete: true,
    report: { score: 80, label: "Good" },
    sections: [{ id: "sensitive-files", name: "Sensitive files", score: 70 }],
    findings,
    ...overrides,
  };
}

export const fence = (body: unknown, info = "json audit-findings"): string =>
  "```" +
  info +
  "\n" +
  (typeof body === "string" ? body : JSON.stringify(body)) +
  "\n```";

export const LEAD_FINDING = makeFinding();
export const LEAD_TEXT = "Audit complete.\n" + fence(makeBlock([LEAD_FINDING]));

export const ECHO_FINDING = makeFinding({
  rule: "secret.hardcoded",
  section: "secret-detection",
  subject: "src/echo.ts",
  title: "Echoed by a sub-agent",
});
export const ECHO_TEXT =
  "Sub-agent notes:\n" + fence(makeBlock([ECHO_FINDING]));

const lead = (text: string): DBMessage => ({
  type: "agent",
  parent_tool_use_id: null,
  parts: [{ type: "text", text }],
});

const sub = (text: string): DBMessage => ({
  type: "agent",
  parent_tool_use_id: "toolu_x",
  parts: [{ type: "text", text }],
});

/** Lead tagged block, then a sub-agent echo, then a fence-less lead resume. */
export const ECHO_AFTER_LEAD: DBMessage[] = [
  { type: "user", model: null, parts: [{ type: "text", text: "audit" }] },
  lead(LEAD_TEXT),
  sub(ECHO_TEXT),
  lead("The sub-agent finished; nothing to add."),
];
