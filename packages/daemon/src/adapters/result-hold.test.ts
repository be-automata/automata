import { describe, expect, it } from "vitest";

import type { ClaudeMessage } from "../shared";
import { claudeAdapter } from "./claude-adapter";
import { createResultHold } from "./result-hold";

const S = "SESSION_Q2Q7";
const init = {
  type: "system",
  subtype: "init",
  session_id: S,
  tools: ["Task"],
  mcp_servers: [],
};
const leadToolUse = (name: string, id = "toolu_1") => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        name,
        id,
        input: { subagent_type: "x", prompt: "p" },
      },
    ],
  },
  session_id: S,
});
const taskStarted = (toolUseId = "toolu_1", backgrounded = true) => ({
  type: "system",
  subtype: "task_started",
  task_id: "t1",
  tool_use_id: toolUseId,
  is_backgrounded: backgrounded,
  session_id: S,
});
const deniedToolResult = {
  type: "user",
  parent_tool_use_id: null,
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        is_error: true,
        content: "Permission to use Task has been denied.",
      },
    ],
  },
  session_id: S,
};
const result1 = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 2,
  total_cost_usd: 0.12,
  duration_ms: 5541,
  duration_api_ms: 11573,
  result: "Waiting for the spike agent…",
  session_id: S,
};
const result2 = {
  ...result1,
  num_turns: 1,
  result: 'Done.\n```json\n{"verdict":"approve"}\n```',
};

/** Feed `lines` in order; return the indexes the hold swallowed. */
function heldIndexes(lines: unknown[]): number[] {
  const hold = createResultHold();
  return lines.flatMap((line, i) =>
    hold.observe(line as ClaudeMessage).held ? [i] : [],
  );
}

describe("createResultHold (Phase 5, Q2/Q7)", () => {
  it.each(["Agent", "Task"])(
    "a backgrounded lead %s arms the hold: every later result is held, the last wins",
    (toolName) => {
      const hold = createResultHold();
      const observed = [
        init,
        leadToolUse(toolName),
        taskStarted(),
        result1,
        result2,
      ].map((m) => hold.observe(m as ClaudeMessage));
      expect(observed.slice(0, 3)).toEqual([
        { held: false },
        { held: false },
        { held: false },
      ]);
      expect(observed[3]).toEqual({ held: true, replacedEarlier: false });
      expect(observed[4]).toEqual({ held: true, replacedEarlier: true });
      expect(hold.drain()).toBe(result2);
      expect(hold.drain()).toBeNull();
    },
  );

  it("NEGATIVE: a DENIED lead Task (no task_started) does not arm", () => {
    expect(
      heldIndexes([init, leadToolUse("Task"), deniedToolResult, result2]),
    ).toEqual([]);
  });

  it("NEGATIVE: a backgrounded task_started for an unknown tool_use id does not arm", () => {
    expect(
      heldIndexes([
        init,
        leadToolUse("Agent"),
        taskStarted("toolu_other"),
        result2,
      ]),
    ).toEqual([]);
  });

  it("NEGATIVE: a SUB-AGENT's Agent tool_use matched by task_started does not arm", () => {
    const subAgentToolUse = {
      ...leadToolUse("Agent", "toolu_sub"),
      parent_tool_use_id: "toolu_1",
    };
    expect(
      heldIndexes([init, subAgentToolUse, taskStarted("toolu_sub"), result2]),
    ).toEqual([]);
  });

  it("NEGATIVE: a lead task_started with is_backgrounded false does not arm", () => {
    expect(
      heldIndexes([
        init,
        leadToolUse("Agent"),
        taskStarted("toolu_1", false),
        result2,
      ]),
    ).toEqual([]);
  });

  it("NEGATIVE: a lead non-sub-agent tool_use does not arm", () => {
    expect(
      heldIndexes([init, leadToolUse("Bash"), taskStarted(), result2]),
    ).toEqual([]);
  });

  it("drain on a never-armed hold is null", () => {
    expect(createResultHold().drain()).toBeNull();
  });
});

describe("claudeAdapter line parser + hold", () => {
  const runtime = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as Parameters<typeof claudeAdapter.makeLineParser>[0]["runtime"];

  it("swallows a held result, signals onResultHeld, and releases the last via drainHeld", () => {
    const parser = claudeAdapter.makeLineParser({ runtime });
    const held: Array<[unknown, boolean]> = [];
    const ctx = {
      isWorking: true,
      onResultHeld: (m: ClaudeMessage, replaced: boolean) =>
        held.push([m, replaced]),
    };
    const emitted = [
      init,
      leadToolUse("Agent"),
      taskStarted(),
      result1,
      result2,
    ].flatMap((m) => parser.parse(JSON.stringify(m), ctx));
    expect(emitted.map((m) => (m as { type: string }).type)).toEqual([
      "system",
      "assistant",
      "system",
    ]);
    expect(held).toEqual([
      [result1, false],
      [result2, true],
    ]);
    expect(parser.drainHeld?.()).toEqual(result2);
    expect(parser.drainHeld?.()).toBeNull();
  });

  it("emits the result unheld when the run never arms", () => {
    const parser = claudeAdapter.makeLineParser({ runtime });
    let signalled = false;
    const ctx = { isWorking: true, onResultHeld: () => (signalled = true) };
    expect(parser.parse(JSON.stringify(result2), ctx)).toEqual([result2]);
    expect(signalled).toBe(false);
    expect(parser.drainHeld?.()).toBeNull();
  });
});
