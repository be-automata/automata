import { describe, expect, it } from "vitest";

import {
  createToolFailureStreak,
  parseStreakLimit,
} from "./tool-failure-streak";

function use(id: string, name: string) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input: {} }],
    },
  };
}

function results(...outcomes: Array<[string, boolean]>) {
  return {
    type: "user",
    message: {
      role: "user",
      content: outcomes.map(([id, isError]) => ({
        type: "tool_result",
        tool_use_id: id,
        content: isError ? "Error: exit code 1" : "ok",
        is_error: isError,
      })),
    },
  };
}

describe("parseStreakLimit", () => {
  it("accepts positive integers only; anything else is observe mode", () => {
    expect(parseStreakLimit(undefined)).toBe(0);
    expect(parseStreakLimit("")).toBe(0);
    expect(parseStreakLimit("0")).toBe(0);
    expect(parseStreakLimit("-3")).toBe(0);
    expect(parseStreakLimit("2.5")).toBe(0);
    expect(parseStreakLimit("abc")).toBe(0);
    expect(parseStreakLimit(" 8 ")).toBe(8);
  });
});

describe("createToolFailureStreak", () => {
  it("a success resets the streak", () => {
    const s = createToolFailureStreak({ limit: 3 });
    s.observe(results(["a", true], ["b", true]));
    expect(s.current()).toBe(2);
    s.observe(results(["c", false]));
    expect(s.current()).toBe(0);
  });

  it("messages without tool results leave the streak unchanged", () => {
    const s = createToolFailureStreak({ limit: 3 });
    s.observe(results(["a", true]));
    s.observe({ type: "assistant", message: { content: [{ type: "text" }] } });
    s.observe({ type: "result", is_error: true });
    s.observe("not an object");
    expect(s.current()).toBe(1);
  });

  it("enforce mode trips once at the limit and names the last tool", () => {
    const s = createToolFailureStreak({ limit: 3 });
    s.observe(use("a", "Bash"));
    expect(s.observe(results(["a", true]))).toEqual({ kind: "none" });
    s.observe(use("b", "Bash"));
    expect(s.observe(results(["b", true]))).toEqual({ kind: "none" });
    s.observe(use("c", "Grep"));
    expect(s.observe(results(["c", true]))).toEqual({
      kind: "trip",
      streak: 3,
      lastTool: "Grep",
    });
    expect(s.observe(results(["d", true]))).toEqual({ kind: "none" });
  });

  it("counts every block of a parallel batch", () => {
    const s = createToolFailureStreak({ limit: 4 });
    expect(
      s.observe(results(["a", true], ["b", true], ["c", true], ["d", true])),
    ).toMatchObject({ kind: "trip", streak: 4, lastTool: null });
  });

  it("a success later in the batch keeps a trip already reached", () => {
    const s = createToolFailureStreak({ limit: 3 });
    expect(
      s.observe(results(["a", true], ["b", true], ["c", true], ["d", false])),
    ).toEqual({ kind: "trip", streak: 3, lastTool: null });
    expect(s.current()).toBe(0);
  });

  it("a success later in the batch keeps a report already reached", () => {
    const s = createToolFailureStreak({ limit: 0 });
    for (let i = 0; i < 4; i += 1) {
      s.observe(results([`x${i}`, true]));
    }
    expect(s.observe(results(["y", true], ["z", false]))).toEqual({
      kind: "report",
      streak: 5,
      lastTool: null,
    });
    expect(s.current()).toBe(0);
  });

  it("observe mode reports every fifth failure and never trips", () => {
    const s = createToolFailureStreak({ limit: 0 });
    const kinds: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      kinds.push(s.observe(results([`id${i}`, true])).kind);
    }
    expect(kinds.filter((k) => k === "report")).toHaveLength(2);
    expect(kinds).not.toContain("trip");
    expect(kinds[4]).toBe("report");
    expect(kinds[9]).toBe("report");
  });
});
