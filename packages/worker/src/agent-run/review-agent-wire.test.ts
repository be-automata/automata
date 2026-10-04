import { describe, expect, it } from "vitest";

import {
  REVIEW_WIRE_COMMAND_TIMEOUT_MS_RANGE,
  REVIEW_WIRE_MAX_TURNS_RANGE,
  buildDaemonReviewAgentWire,
  reviewAgentForRun,
  withReviewAgentWire,
} from "./review-agent-wire";
import type { PulledDaemonMessage, ReviewAgentShape } from "./types";

const ORCHESTRATED: ReviewAgentShape = {
  mode: "orchestrated",
  batteries: ["gstack-review"],
  runTests: true,
  runTestsDowngradedReason: "fork",
  commandTimeoutMs: 300000,
  maxTurns: 40,
};
const CLASSIC: ReviewAgentShape = {
  mode: "classic",
  batteries: [],
  runTests: false,
  commandTimeoutMs: 60000,
};
const MESSAGE: PulledDaemonMessage = {
  type: "claude",
  model: "sonnet",
  agent: "claudeCode",
  agentVersion: 1,
  prompt: "review",
  sessionId: null,
  permissionMode: "review",
  featureFlags: {},
};

describe("ranges mirror Phase 4", () => {
  it("are 60000..600000 ms and 1..500 turns", () => {
    expect(REVIEW_WIRE_COMMAND_TIMEOUT_MS_RANGE).toEqual([60000, 600000]);
    expect(REVIEW_WIRE_MAX_TURNS_RANGE).toEqual([1, 500]);
  });
});

describe("buildDaemonReviewAgentWire", () => {
  it("is none without reviewAgent, for classic, and for non-review runs", () => {
    expect(buildDaemonReviewAgentWire(undefined, "review")).toEqual({
      kind: "none",
    });
    expect(buildDaemonReviewAgentWire(CLASSIC, "review")).toEqual({
      kind: "none",
    });
    expect(buildDaemonReviewAgentWire(ORCHESTRATED, "allowAll")).toEqual({
      kind: "none",
    });
    expect(buildDaemonReviewAgentWire(ORCHESTRATED, "plan")).toEqual({
      kind: "none",
    });
  });

  it("forwards exactly {mode, commandTimeoutMs, maxTurns} — never runTests/batteries", () => {
    const out = buildDaemonReviewAgentWire(ORCHESTRATED, "review");
    expect(out).toEqual({
      kind: "wire",
      wire: { mode: "orchestrated", commandTimeoutMs: 300000, maxTurns: 40 },
    });
    expect(JSON.stringify(out)).not.toMatch(
      /runTests|batteries|Downgraded|gstack/,
    );
  });

  it("omits the maxTurns key when maxTurns is absent", () => {
    const { maxTurns: _drop, ...noTurns } = ORCHESTRATED;
    const out = buildDaemonReviewAgentWire(noTurns, "review");
    expect(out.kind).toBe("wire");
    if (out.kind === "wire") {
      expect("maxTurns" in out.wire).toBe(false);
    }
  });

  it.each([
    [{ commandTimeoutMs: 59999 }, "commandTimeoutMs", "60000..600000"],
    [{ commandTimeoutMs: 600001 }, "commandTimeoutMs", "60000..600000"],
    [{ commandTimeoutMs: 1.5 }, "commandTimeoutMs", "60000..600000"],
    [{ maxTurns: 0 }, "maxTurns", "1..500"],
    [{ maxTurns: 501 }, "maxTurns", "1..500"],
    [{ maxTurns: 2.5 }, "maxTurns", "1..500"],
  ])("rejects %j naming %s and its bound", (patch, field, bound) => {
    const out = buildDaemonReviewAgentWire(
      { ...ORCHESTRATED, ...patch },
      "review",
    );
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") {
      expect(out.reason).toContain(field);
      expect(out.reason).toContain(bound);
      expect(out.reason).not.toMatch(/gstack|fork|runTests/);
    }
  });

  it.each([
    [{ commandTimeoutMs: 60000 }],
    [{ commandTimeoutMs: 600000 }],
    [{ maxTurns: 1 }],
    [{ maxTurns: 500 }],
  ])("accepts the boundary %j", (patch) => {
    expect(
      buildDaemonReviewAgentWire({ ...ORCHESTRATED, ...patch }, "review").kind,
    ).toBe("wire");
  });
});

describe("withReviewAgentWire", () => {
  it("returns the SAME message for none (byte-identical JSON)", () => {
    const before = JSON.stringify(MESSAGE);
    const out = withReviewAgentWire(MESSAGE, CLASSIC);
    expect(out.message).toBe(MESSAGE);
    expect(out.rejected).toBeUndefined();
    expect(JSON.stringify(out.message)).toBe(before);
    expect(withReviewAgentWire(MESSAGE, undefined).message).toBe(MESSAGE);
  });

  it("returns the SAME message and surfaces the reason for rejected", () => {
    const out = withReviewAgentWire(MESSAGE, {
      ...ORCHESTRATED,
      commandTimeoutMs: 5,
    });
    expect(out.message).toBe(MESSAGE);
    expect(out.rejected).toContain("commandTimeoutMs");
  });

  it("stamps a NEW message for wire and never mutates the input", () => {
    const before = JSON.stringify(MESSAGE);
    const out = withReviewAgentWire(MESSAGE, ORCHESTRATED);
    expect(out.message).not.toBe(MESSAGE);
    expect(out.message).toEqual({
      ...MESSAGE,
      reviewAgent: {
        mode: "orchestrated",
        commandTimeoutMs: 300000,
        maxTurns: 40,
      },
    });
    expect(JSON.stringify(MESSAGE)).toBe(before);
  });
});

describe("reviewAgentForRun (bounds BEFORE seeding)", () => {
  it("passes classic, absent and in-bounds orchestrated through by reference", () => {
    expect(reviewAgentForRun(undefined)).toEqual({});
    expect(reviewAgentForRun(CLASSIC).reviewAgent).toBe(CLASSIC);
    expect(reviewAgentForRun(ORCHESTRATED).reviewAgent).toBe(ORCHESTRATED);
  });

  it("drops an out-of-bounds orchestrated reviewAgent so the run seeds and runs classic", () => {
    const out = reviewAgentForRun({ ...ORCHESTRATED, maxTurns: 501 });
    expect(out.reviewAgent).toBeUndefined();
    expect(out.rejected).toContain("maxTurns");
  });
});
