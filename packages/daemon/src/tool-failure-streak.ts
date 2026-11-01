/**
 * Stuck-agent detection: a streak of consecutive failed tool calls.
 *
 * A tool error is returned to the model, so a few failures in a row are the
 * model working (a rejected command rewritten, a grep with no match). A long
 * unbroken streak says nothing in the results is being read, and without this
 * detector such a run burns until the idle watchdog or the run timeout.
 *
 * Every `tool_result` block is one call: a failed one extends the streak, a
 * successful one resets it. Messages without tool results leave it unchanged.
 *
 * Two modes, chosen by `limit`:
 * - observe (`limit` 0, the default): the streak is reported at each multiple
 *   of `OBSERVE_REPORT_EVERY` and the run continues. This is how the
 *   threshold gets set from real runs before anything is stopped.
 * - enforce (`limit` > 0): the streak reaching `limit` trips the detector and
 *   the caller stops the run.
 */

/** Streak lengths at which observe mode reports (5, 10, 15, ...). */
export const OBSERVE_REPORT_EVERY = 5;

/** Env key that switches the detector to enforce mode with that limit. */
export const TOOL_FAILURE_STREAK_LIMIT_ENV = "TOOL_FAILURE_STREAK_LIMIT";

export type StreakVerdict =
  | { kind: "none" }
  | { kind: "report"; streak: number; lastTool: string | null }
  | { kind: "trip"; streak: number; lastTool: string | null };

export interface ToolFailureStreak {
  observe: (message: unknown) => StreakVerdict;
  current: () => number;
}

interface ToolResultBlock {
  isError: boolean;
  toolUseId: string | null;
}

/** Parses the limit; anything but a positive integer means observe mode. */
export function parseStreakLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return 0;
  }
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function contentBlocks(message: unknown): unknown[] {
  if (!isRecord(message) || !isRecord(message.message)) {
    return [];
  }
  const content = message.message.content;
  return Array.isArray(content) ? content : [];
}

function toolResults(message: unknown): ToolResultBlock[] {
  if (!isRecord(message) || message.type !== "user") {
    return [];
  }
  const results: ToolResultBlock[] = [];
  for (const block of contentBlocks(message)) {
    if (isRecord(block) && block.type === "tool_result") {
      results.push({
        isError: block.is_error === true,
        toolUseId:
          typeof block.tool_use_id === "string" ? block.tool_use_id : null,
      });
    }
  }
  return results;
}

function toolUses(message: unknown): Array<{ id: string; name: string }> {
  if (!isRecord(message) || message.type !== "assistant") {
    return [];
  }
  const uses: Array<{ id: string; name: string }> = [];
  for (const block of contentBlocks(message)) {
    if (
      isRecord(block) &&
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      uses.push({ id: block.id, name: block.name });
    }
  }
  return uses;
}

/** Bound on remembered tool_use ids (names only feed the report). */
const MAX_TRACKED_TOOL_USES = 256;

export function createToolFailureStreak({
  limit,
}: {
  limit: number;
}): ToolFailureStreak {
  let streak = 0;
  let tripped = false;
  let lastTool: string | null = null;
  const toolNames = new Map<string, string>();

  const observe = (message: unknown): StreakVerdict => {
    for (const use of toolUses(message)) {
      toolNames.set(use.id, use.name);
      if (toolNames.size > MAX_TRACKED_TOOL_USES) {
        const oldest = toolNames.keys().next().value;
        if (oldest !== undefined) {
          toolNames.delete(oldest);
        }
      }
    }
    const results = toolResults(message);
    if (results.length === 0) {
      return { kind: "none" };
    }
    let verdict: StreakVerdict = { kind: "none" };
    for (const result of results) {
      if (!result.isError) {
        // Reset the count only: a trip or report already reached earlier in
        // this batch must still reach the caller (the trip is latched).
        streak = 0;
        continue;
      }
      streak += 1;
      lastTool =
        result.toolUseId !== null
          ? (toolNames.get(result.toolUseId) ?? null)
          : null;
      if (limit > 0) {
        if (!tripped && streak >= limit) {
          tripped = true;
          verdict = { kind: "trip", streak, lastTool };
        }
      } else if (streak % OBSERVE_REPORT_EVERY === 0) {
        verdict = { kind: "report", streak, lastTool };
      }
    }
    return verdict;
  };

  return { observe, current: () => streak };
}
