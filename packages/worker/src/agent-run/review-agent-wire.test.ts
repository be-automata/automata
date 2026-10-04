import { describe, expect, it } from "vitest";

import { DaemonReviewAgentSchema } from "@terragon/daemon/shared";

import {
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

describe("buildDaemonReviewAgentWire", () => {
  it("is undefined without reviewAgent, for classic, and for non-review runs", () => {
    expect(buildDaemonReviewAgentWire(undefined, "review")).toBeUndefined();
    expect(buildDaemonReviewAgentWire(CLASSIC, "review")).toBeUndefined();
    expect(
      buildDaemonReviewAgentWire(ORCHESTRATED, "allowAll"),
    ).toBeUndefined();
    expect(buildDaemonReviewAgentWire(ORCHESTRATED, "plan")).toBeUndefined();
  });

  it("forwards exactly {mode, commandTimeoutMs, maxTurns} — never runTests/batteries", () => {
    const out = buildDaemonReviewAgentWire(ORCHESTRATED, "review");
    expect(out).toEqual({
      mode: "orchestrated",
      commandTimeoutMs: 300000,
      maxTurns: 40,
    });
    expect(JSON.stringify(out)).not.toMatch(
      /runTests|batteries|Downgraded|gstack/,
    );
  });

  it("omits the maxTurns key when maxTurns is absent", () => {
    const { maxTurns: _drop, ...noTurns } = ORCHESTRATED;
    const out = buildDaemonReviewAgentWire(noTurns, "review");
    expect(out).toBeDefined();
    expect(out && "maxTurns" in out).toBe(false);
  });

  it("every wire it builds from a gated reviewAgent passes the daemon's own schema", () => {
    const gated = reviewAgentForRun(ORCHESTRATED).reviewAgent;
    const out = buildDaemonReviewAgentWire(gated, "review");
    expect(DaemonReviewAgentSchema.safeParse(out).success).toBe(true);
  });
});

describe("withReviewAgentWire", () => {
  it("returns the SAME message without a wire (byte-identical JSON)", () => {
    const before = JSON.stringify(MESSAGE);
    const out = withReviewAgentWire(MESSAGE, CLASSIC);
    expect(out).toBe(MESSAGE);
    expect(JSON.stringify(out)).toBe(before);
    expect(withReviewAgentWire(MESSAGE, undefined)).toBe(MESSAGE);
  });

  it("stamps a NEW message for an orchestrated review and never mutates the input", () => {
    const before = JSON.stringify(MESSAGE);
    const out = withReviewAgentWire(MESSAGE, ORCHESTRATED);
    expect(out).not.toBe(MESSAGE);
    expect(out).toEqual({
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

describe("reviewAgentForRun (the one bounds gate, BEFORE seeding)", () => {
  it("passes classic, absent and in-bounds orchestrated through by reference", () => {
    expect(reviewAgentForRun(undefined)).toEqual({});
    expect(reviewAgentForRun(CLASSIC).reviewAgent).toBe(CLASSIC);
    expect(reviewAgentForRun(ORCHESTRATED).reviewAgent).toBe(ORCHESTRATED);
  });

  it.each([
    [{ commandTimeoutMs: 59999 }, "commandTimeoutMs", "60000..600000"],
    [{ commandTimeoutMs: 600001 }, "commandTimeoutMs", "60000..600000"],
    [{ commandTimeoutMs: 1.5 }, "commandTimeoutMs", "60000..600000"],
    [{ maxTurns: 0 }, "maxTurns", "1..500"],
    [{ maxTurns: 501 }, "maxTurns", "1..500"],
    [{ maxTurns: 2.5 }, "maxTurns", "1..500"],
  ])(
    "drops %j (run seeds and runs classic), naming %s and its bound",
    (patch, field, bound) => {
      const out = reviewAgentForRun({ ...ORCHESTRATED, ...patch });
      expect(out.reviewAgent).toBeUndefined();
      expect(out.rejected).toContain(field);
      expect(out.rejected).toContain(bound);
      expect(out.rejected).not.toMatch(/gstack|fork|runTests/);
    },
  );

  it.each([
    [{ commandTimeoutMs: 60000 }],
    [{ commandTimeoutMs: 600000 }],
    [{ maxTurns: 1 }],
    [{ maxTurns: 500 }],
  ])("accepts the boundary %j", (patch) => {
    const candidate = { ...ORCHESTRATED, ...patch };
    expect(reviewAgentForRun(candidate).reviewAgent).toBe(candidate);
  });
});
