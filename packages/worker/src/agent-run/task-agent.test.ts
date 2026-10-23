import { describe, expect, it } from "vitest";

import { resolveRunLane } from "./run-lane";
import {
  TASK_AGENT_MAX_PACKS,
  formatBatteriesLine,
  taskAgentForRun,
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

  it("an unknown but well-formed id passes (the image is the authority)", () => {
    expect(gateFor({ batteries: ["not-in-manifest"] })).toEqual({
      kind: "seed",
      batteries: ["not-in-manifest"],
      lane: "task",
    });
  });
});

describe("formatBatteriesLine (ADR-013)", () => {
  const imageDigest = `sha256:${"ab12".repeat(16)}`;

  // card: protects=every run logs which image its batteries come from (12 hex of the digest) and its lane, and a task run names the pack ids it asked for or that they were invalid; fails_when=the digest, lane or pack list is missing or a refused gate prints its value; no_claim=what the image contains (verify.sh)
  it("names the image digest and lane, plus the task packs when the run carried any", () => {
    expect(
      formatBatteriesLine({
        imageDigest,
        lane: "review",
        taskGate: { kind: "none" },
      }),
    ).toBe("batteries: image=ab12ab12ab12 lane=review");
    expect(
      formatBatteriesLine({
        imageDigest,
        lane: "task",
        taskGate: gateFor({ batteries: ["gsd", "ruflo"] }),
      }),
    ).toBe("batteries: image=ab12ab12ab12 lane=task task-packs=gsd,ruflo");
    expect(
      formatBatteriesLine({
        imageDigest,
        lane: "task",
        taskGate: gateFor({ batteries: ["Bad Id"] }),
      }),
    ).toBe("batteries: image=ab12ab12ab12 lane=task task-packs=invalid");
    // A review that carried packs is refused by the gate and logs nothing extra.
    expect(
      formatBatteriesLine({
        imageDigest,
        lane: "review",
        taskGate: gateFor({ batteries: ["gsd"] }, { prKey: "acme/web#1" }),
      }),
    ).toBe("batteries: image=ab12ab12ab12 lane=review");
  });
});
