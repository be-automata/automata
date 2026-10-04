import { describe, expect, it } from "vitest";

import { resolveRunLane } from "./run-lane";
import {
  TASK_AGENT_MAX_PACKS,
  batterySeedForRun,
  foregroundOnlyForRun,
  readTokenForRun,
  taskAgentForRun,
  taskRunOutcome,
  type TaskAgentGate,
} from "./task-agent";
import type { AgentRunInput } from "./types";

type LaneInput = Pick<AgentRunInput, "prKey" | "supersedePolicy" | "prNumber">;

/** The gate as the workflow calls it: the run's lane computed once. */
function gateFor(taskAgent: unknown, over: Partial<LaneInput> = {}) {
  // The gate's whole job is to bound an untrusted shape, so tests feed it
  // values the type would forbid.
  return taskAgentForRun(
    taskAgent as AgentRunInput["taskAgent"],
    resolveRunLane(over),
  );
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `pack-${i}`);

describe("taskAgentForRun (phase 7)", () => {
  it("no taskAgent ⇒ none", () => {
    expect(gateFor(undefined)).toEqual({ kind: "none" });
  });

  it("a task-lane run with a valid list ⇒ seed with a copy, lane task", () => {
    const batteries = ["somnio-skills"];
    const gate = gateFor({ batteries });
    expect(gate).toEqual({
      kind: "seed",
      batteries: ["somnio-skills"],
      lane: "task",
    });
    if (gate.kind !== "seed") throw new Error("not seed");
    expect(gate.batteries).not.toBe(batteries);
  });

  it("prNumber only (a mention on a PR) ⇒ lane pr", () => {
    expect(gateFor({ batteries: ["somnio-skills"] }, { prNumber: 7 })).toEqual({
      kind: "seed",
      batteries: ["somnio-skills"],
      lane: "pr",
    });
  });

  it.each([
    [{ prKey: "acme/web#1" }],
    [{ supersedePolicy: "newest-wins" as const }],
    [{ prKey: "acme/web#1", prNumber: 1 }],
  ])("review-lane input %j ⇒ rejected review-lane", (over) => {
    expect(gateFor({ batteries: ["somnio-skills"] }, over)).toEqual({
      kind: "rejected",
      lane: "review",
      reason: "review-lane",
    });
  });

  it(`${TASK_AGENT_MAX_PACKS} packs pass, ${TASK_AGENT_MAX_PACKS + 1} are rejected`, () => {
    expect(TASK_AGENT_MAX_PACKS).toBe(16);
    expect(gateFor({ batteries: ids(16) }).kind).toBe("seed");
    const gate = gateFor({ batteries: ids(17) });
    expect(gate).toMatchObject({ kind: "rejected", lane: "task" });
    if (gate.kind !== "rejected") throw new Error("not rejected");
    expect(gate.reason).toContain("16");
  });

  it.each([
    ["not an object", "somnio-skills"],
    ["null", null],
    ["batteries missing", {}],
    ["batteries not an array", { batteries: "somnio-skills" }],
    ["empty", { batteries: [] }],
    ["a non-string", { batteries: ["ok", 42] }],
    ["not an id", { batteries: ["Bad Id"] }],
    ["a path", { batteries: ["../etc"] }],
    ["duplicate", { batteries: ["somnio-skills", "somnio-skills"] }],
  ])("%s ⇒ rejected; the reason never echoes the value", (_name, taskAgent) => {
    const gate = gateFor(taskAgent);
    expect(gate).toMatchObject({ kind: "rejected", lane: "task" });
    if (gate.kind !== "rejected") throw new Error("not rejected");
    expect(gate.reason).not.toMatch(/Bad Id|\.\.\/etc|somnio-skills|42/);
    expect(gate.reason.length).toBeGreaterThan(0);
  });

  it("names the failing index for an element rule", () => {
    const gate = gateFor({ batteries: ["ok", "Bad Id"] });
    if (gate.kind !== "rejected") throw new Error("not rejected");
    expect(gate.reason).toContain("[1]");
  });

  it("an unknown but well-formed id passes (the manifest is the authority)", () => {
    expect(gateFor({ batteries: ["not-in-manifest"] })).toEqual({
      kind: "seed",
      batteries: ["not-in-manifest"],
      lane: "task",
    });
  });
});

describe("foregroundOnlyForRun", () => {
  it.each(["task", "pr"] as const)(
    "every %s-lane run gets the guard, with or without packs",
    (lane) => {
      expect(foregroundOnlyForRun(lane, undefined)).toBe(true);
      expect(
        foregroundOnlyForRun(lane, {
          batteries: ["somnio-skills"],
          hooksOff: false,
        }),
      ).toBe(true);
    },
  );

  it("review runs never get it (classic or orchestrated)", () => {
    expect(foregroundOnlyForRun("review", undefined)).toBe(false);
    expect(
      foregroundOnlyForRun("review", {
        batteries: ["gstack-review"],
        hooksOff: true,
      }),
    ).toBe(false);
  });

  it("a hooks-off seed keeps its settings, whatever the lane", () => {
    expect(
      foregroundOnlyForRun("task", { batteries: [], hooksOff: true }),
    ).toBe(false);
  });
});

describe("batterySeedForRun (phase 5/7)", () => {
  const SEED_GATE: TaskAgentGate = {
    kind: "seed",
    batteries: ["somnio-skills"],
    lane: "task",
  };

  it("an orchestrated review seeds its packs with hooks off", () => {
    expect(
      batterySeedForRun(
        { mode: "orchestrated", batteries: ["gstack-review"] },
        { kind: "none" },
      ),
    ).toEqual({ batteries: ["gstack-review"], hooksOff: true });
  });

  it("a task seed links its packs with hooks on", () => {
    expect(batterySeedForRun(undefined, SEED_GATE)).toEqual({
      batteries: ["somnio-skills"],
      hooksOff: false,
    });
  });

  it("an orchestrated review wins over a task seed", () => {
    expect(
      batterySeedForRun(
        { mode: "orchestrated", batteries: ["gstack-review"] },
        SEED_GATE,
      ),
    ).toEqual({ batteries: ["gstack-review"], hooksOff: true });
  });

  it.each<[string, Parameters<typeof batterySeedForRun>]>([
    ["absent review, no task gate", [undefined, { kind: "none" }]],
    [
      "classic review",
      [{ mode: "classic", batteries: ["gstack-review"] }, { kind: "none" }],
    ],
    [
      "rejected task gate",
      [undefined, { kind: "rejected", lane: "task", reason: "x" }],
    ],
    [
      "an empty task list",
      [undefined, { kind: "seed", batteries: [], lane: "task" }],
    ],
  ])("%s ⇒ no seed (HOME exactly today's)", (_name, args) => {
    expect(batterySeedForRun(...args)).toBeUndefined();
  });
});

describe("readTokenForRun (phase 7, read-only task token gate)", () => {
  const NOW = Date.parse("2026-10-04T02:00:00Z");
  const SEED_GATE = {
    kind: "seed" as const,
    batteries: ["somnio-skills"],
    lane: "task" as const,
  };
  const SEEDED = {
    ok: true as const,
    packs: ["somnio-skills"],
    manifestHash: "a".repeat(64),
    requires: ["github-read-token"],
  };
  const inMs = (ms: number) => new Date(NOW + ms).toISOString();
  const gate = (over: Record<string, unknown> = {}) =>
    readTokenForRun({
      lane: "task",
      taskGate: SEED_GATE,
      seeded: SEEDED,
      input: {
        githubReadToken: "ghs_read",
        githubReadTokenExpiresAt: inMs(30 * 60_000),
      },
      brokered: true,
      now: NOW,
      ...over,
    } as Parameters<typeof readTokenForRun>[0]);

  it("all conditions hold ⇒ the token", () => {
    expect(gate()).toEqual({ token: "ghs_read" });
  });

  it("no expiry shipped ⇒ allowed (GitHub caps the token at 1h)", () => {
    expect(gate({ input: { githubReadToken: "ghs_read" } })).toEqual({
      token: "ghs_read",
    });
  });

  it.each([
    ["30 s from now (inside the 1-minute margin)", inMs(30_000)],
    ["exactly at the margin", inMs(60_000)],
    ["in the past", inMs(-1)],
    ["unparseable", "garbage"],
  ])("expiresAt %s ⇒ expired", (_name, expiresAt) => {
    expect(
      gate({
        input: {
          githubReadToken: "ghs_read",
          githubReadTokenExpiresAt: expiresAt,
        },
      }),
    ).toEqual({ skip: "expired" });
  });

  it("review lane with a forged token ⇒ review-lane", () => {
    expect(
      gate({
        lane: "review",
        taskGate: { kind: "rejected", lane: "review", reason: "review-lane" },
      }),
    ).toEqual({ skip: "review-lane" });
    expect(gate({ lane: "review" })).toEqual({ skip: "review-lane" });
  });

  it.each([
    ["no task gate seed", { taskGate: { kind: "none" } }],
    [
      "seeding unavailable",
      { seeded: { ok: false, reason: "manifest-drift" } },
    ],
    ["not seeded at all", { seeded: undefined }],
    [
      "no seeded pack requires it",
      {
        seeded: {
          ok: true,
          packs: ["somnio-review"],
          manifestHash: "a".repeat(64),
        },
      },
    ],
  ])("%s ⇒ no-requiring-pack", (_name, over) => {
    expect(gate(over)).toEqual({ skip: "no-requiring-pack" });
  });

  it.each([[{}], [{ githubReadToken: "" }]])(
    "token absent (%j) ⇒ not-delivered",
    (input) => {
      expect(gate({ input })).toEqual({ skip: "not-delivered" });
    },
  );

  it("legacy (not brokered) ⇒ no-broker", () => {
    expect(gate({ brokered: false })).toEqual({ skip: "no-broker" });
  });
});

describe("taskRunOutcome (phase 7)", () => {
  const SEEDED = {
    ok: true as const,
    packs: ["somnio-skills"],
    manifestHash: "0123456789ab".padEnd(64, "f"),
    requires: ["github-read-token"],
  };
  const base = {
    lane: "task" as const,
    seeded: SEEDED,
    input: { githubReadToken: "ghs_read" },
    brokered: true,
    now: Date.parse("2026-10-04T02:00:00Z"),
  };

  it("a seeding gate: the lane line, the applied line and the token", () => {
    expect(
      taskRunOutcome({
        ...base,
        taskGate: { kind: "seed", batteries: ["somnio-skills"], lane: "task" },
      }),
    ).toEqual({
      batteriesLine:
        "batteries: lane=task packs=somnio-skills manifest=0123456789ab",
      readTokenLine: "task agent: read-token=applied",
      githubReadToken: "ghs_read",
    });
  });

  it("a seeding gate that skips: one skip=<reason> line, no token", () => {
    expect(
      taskRunOutcome({
        ...base,
        brokered: false,
        taskGate: { kind: "seed", batteries: ["somnio-skills"], lane: "pr" },
      }),
    ).toEqual({
      batteriesLine:
        "batteries: lane=pr packs=somnio-skills manifest=0123456789ab",
      readTokenLine: "task agent: read-token=skip=no-broker",
    });
  });

  it.each<[string, TaskAgentGate, string]>([
    [
      "none",
      { kind: "none" },
      "batteries: mode=orchestrated packs=somnio-skills manifest=0123456789ab",
    ],
    [
      "rejected on the review lane",
      { kind: "rejected", lane: "review", reason: "review-lane" },
      "batteries: mode=orchestrated packs=somnio-skills manifest=0123456789ab",
    ],
    [
      "rejected on the task lane",
      { kind: "rejected", lane: "task", reason: "x" },
      "batteries: unavailable lane=task reason=task-agent-invalid",
    ],
  ])(
    "gate %s: only the batteries line — no read-token line, no token, even with one shipped",
    (_name, taskGate, line) => {
      expect(taskRunOutcome({ ...base, taskGate })).toEqual({
        batteriesLine: line,
      });
    },
  );
});
