import { describe, expect, it, vi } from "vitest";

import {
  formatSelfHealDecisionLine,
  logSelfHealDecision,
  type SelfHealDecisionFields,
} from "./decision-log";

const FIELDS: SelfHealDecisionFields = {
  organizationId: "org-1",
  repoFullName: "acme/widgets",
  runId: "run-9",
  fingerprint: "0123456789abcdef",
  decision: "create",
  reason: "consensus_met",
  mode: "on",
};

describe("formatSelfHealDecisionLine", () => {
  it("is pinned to the v1 format", () => {
    expect(formatSelfHealDecisionLine(FIELDS)).toBe(
      "[self-heal] v=1 org=org-1 repo=acme/widgets run=run-9 fp=01234567 decision=create reason=consensus_met mode=on",
    );
  });

  it("supports would_ decisions and every mode", () => {
    expect(
      formatSelfHealDecisionLine({
        ...FIELDS,
        decision: "would_create",
        mode: "dry-run",
      }),
    ).toContain("decision=would_create reason=consensus_met mode=dry-run");
  });

  it.each(["has space", "new\nline", "UPPER", "", "semi;colon"])(
    "throws on reason %j",
    (reason) => {
      expect(() => formatSelfHealDecisionLine({ ...FIELDS, reason })).toThrow(
        /reason/,
      );
    },
  );

  it("throws when an id could split the line", () => {
    expect(() =>
      formatSelfHealDecisionLine({ ...FIELDS, runId: "run 9" }),
    ).toThrow(/runId/);
  });
});

describe("logSelfHealDecision", () => {
  it("captures exactly the 7 fields once and logs the line", () => {
    const log = vi.fn();
    const capture = vi.fn();
    logSelfHealDecision({ log, capture }, FIELDS);
    expect(log).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
    const [event, props] = capture.mock.calls[0] ?? [];
    expect(event).toBe("self_heal_decision");
    expect(Object.keys(props as object).sort()).toEqual(
      [
        "decision",
        "fingerprint",
        "mode",
        "organizationId",
        "reason",
        "repoFullName",
        "runId",
      ].sort(),
    );
    expect(props).toEqual(FIELDS);
  });

  it("never emits a title, subject or plan text for a publicSafe=false rule", () => {
    const secretTitle = "AKIAIOSFODNN7EXAMPLE leaked in .env.production";
    const log = vi.fn();
    const capture = vi.fn();
    // A caller that wrongly passes extra properties still cannot leak them.
    const fields = {
      ...FIELDS,
      title: secretTitle,
      subject: ".env.production",
      plan: "rotate the key",
    } as SelfHealDecisionFields;
    logSelfHealDecision({ log, capture }, fields);
    const emitted = JSON.stringify([log.mock.calls, capture.mock.calls]);
    expect(emitted).not.toContain("AKIA");
    expect(emitted).not.toContain(".env");
    expect(emitted).not.toContain("rotate");
  });
});
