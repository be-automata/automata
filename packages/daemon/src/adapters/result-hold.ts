import type { ClaudeMessage } from "../shared";

/**
 * Claude's held-result state machine (Phase 5, 02-FINDINGS Q2/Q7).
 *
 * Claude 2.1.284 runs the Agent tool in the background in -p mode and then
 * emits TWO `result` messages — the first holds the lead's interim text
 * ("Waiting for the agent…"), the second its real answer (q2q7.jsonl lines
 * 5/7/29/30). Once the LEAD's own Agent/Task tool_use is confirmed
 * backgrounded (`system/task_started` with `is_backgrounded: true` and that
 * same `tool_use_id`), every result is held and only the LAST is released at
 * process exit. `total_cost_usd` is cumulative, so dropping the interim
 * result loses no accounting. Runs that never arm keep today's exact timing.
 */
export interface ResultHold {
  /**
   * Feed one parsed message, in stream order. Returns `held` when the message
   * is a result that is now held (the caller must not emit it), with
   * `replacedEarlier` when it displaced a previously held result.
   */
  observe(
    message: ClaudeMessage,
  ): { held: false } | { held: true; replacedEarlier: boolean };
  /** Take (and clear) the held result, if any. */
  drain(): ClaudeMessage | null;
}

/** Lead (parent_tool_use_id null) Agent/Task tool_use ids in an assistant message. */
function leadSubAgentToolUseIds(message: unknown): string[] {
  const m = message as {
    type?: unknown;
    parent_tool_use_id?: unknown;
    message?: { content?: unknown };
  };
  if (m.type !== "assistant" || m.parent_tool_use_id !== null) {
    return [];
  }
  const content = m.message?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const ids: string[] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    if (
      part?.type === "tool_use" &&
      (part.name === "Agent" || part.name === "Task") &&
      typeof part.id === "string"
    ) {
      ids.push(part.id);
    }
  }
  return ids;
}

/** tool_use_id of a backgrounded `system/task_started`, else undefined. */
function backgroundedTaskToolUseId(message: unknown): string | undefined {
  const m = message as {
    type?: unknown;
    subtype?: unknown;
    is_backgrounded?: unknown;
    tool_use_id?: unknown;
  };
  return m.type === "system" &&
    m.subtype === "task_started" &&
    m.is_backgrounded === true &&
    typeof m.tool_use_id === "string"
    ? m.tool_use_id
    : undefined;
}

export function createResultHold(): ResultHold {
  const leadTaskToolUseIds = new Set<string>();
  let armed = false;
  let held: ClaudeMessage | null = null;
  return {
    observe(message) {
      for (const id of leadSubAgentToolUseIds(message)) {
        leadTaskToolUseIds.add(id);
      }
      const backgrounded = backgroundedTaskToolUseId(message);
      if (backgrounded && leadTaskToolUseIds.has(backgrounded)) {
        armed = true;
      }
      if (!armed || (message as { type?: unknown }).type !== "result") {
        return { held: false };
      }
      const replacedEarlier = held !== null;
      held = message;
      return { held: true, replacedEarlier };
    },
    drain() {
      const out = held;
      held = null;
      return out;
    },
  };
}
