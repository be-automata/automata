import { describe, expect, it } from "vitest";

import { TASK_AGENT_MAX_PACKS, taskAgentForRun } from "./task-agent";
import type { AgentRunInput } from "./types";

type GateInput = Parameters<typeof taskAgentForRun>[0];

function input(
  taskAgent: unknown,
  over: Partial<
    Pick<AgentRunInput, "prKey" | "supersedePolicy" | "prNumber">
  > = {},
): GateInput {
  // The gate's whole job is to bound an untrusted shape, so tests feed it
  // values the type would forbid.
  return { taskAgent, ...over } as GateInput;
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `pack-${i}`);

describe("taskAgentForRun (phase 7)", () => {
  it("no taskAgent ⇒ none", () => {
    expect(taskAgentForRun(input(undefined))).toEqual({ kind: "none" });
  });

  it("a task-lane run with a valid list ⇒ seed with a copy, lane task", () => {
    const batteries = ["somnio-skills"];
    const gate = taskAgentForRun(input({ batteries }));
    expect(gate).toEqual({
      kind: "seed",
      batteries: ["somnio-skills"],
      lane: "task",
    });
    if (gate.kind !== "seed") throw new Error("not seed");
    expect(gate.batteries).not.toBe(batteries);
  });

  it("prNumber only (a mention on a PR) ⇒ lane pr", () => {
    expect(
      taskAgentForRun(input({ batteries: ["somnio-skills"] }, { prNumber: 7 })),
    ).toEqual({ kind: "seed", batteries: ["somnio-skills"], lane: "pr" });
  });

  it.each([
    [{ prKey: "acme/web#1" }],
    [{ supersedePolicy: "newest-wins" as const }],
    [{ prKey: "acme/web#1", prNumber: 1 }],
  ])("review-lane input %j ⇒ rejected review-lane", (over) => {
    expect(
      taskAgentForRun(input({ batteries: ["somnio-skills"] }, over)),
    ).toEqual({ kind: "rejected", lane: "review", reason: "review-lane" });
  });

  it(`${TASK_AGENT_MAX_PACKS} packs pass, ${TASK_AGENT_MAX_PACKS + 1} are rejected`, () => {
    expect(TASK_AGENT_MAX_PACKS).toBe(16);
    expect(taskAgentForRun(input({ batteries: ids(16) })).kind).toBe("seed");
    const gate = taskAgentForRun(input({ batteries: ids(17) }));
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
    const gate = taskAgentForRun(input(taskAgent));
    expect(gate).toMatchObject({ kind: "rejected", lane: "task" });
    if (gate.kind !== "rejected") throw new Error("not rejected");
    expect(gate.reason).not.toMatch(/Bad Id|\.\.\/etc|somnio-skills|42/);
    expect(gate.reason.length).toBeGreaterThan(0);
  });

  it("names the failing index for an element rule", () => {
    const gate = taskAgentForRun(input({ batteries: ["ok", "Bad Id"] }));
    if (gate.kind !== "rejected") throw new Error("not rejected");
    expect(gate.reason).toContain("[1]");
  });

  it("an unknown but well-formed id passes (the manifest is the authority)", () => {
    expect(taskAgentForRun(input({ batteries: ["not-in-manifest"] }))).toEqual({
      kind: "seed",
      batteries: ["not-in-manifest"],
      lane: "task",
    });
  });
});
