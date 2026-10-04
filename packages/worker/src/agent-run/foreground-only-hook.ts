/**
 * Foreground-only guard for headless TASK runs.
 *
 * A task run is `claude -p`: when the agent ends its turn the session exits,
 * and background Bash (`run_in_background: true`) is killed about five seconds
 * after the final result. An agent that starts a long command in the
 * background (or watches one with Monitor) and then ends its turn abandons
 * that work, and the run "completes" with nothing done. Background
 * sub-agents (Agent/Task) do keep the session open (the daemon's result-hold),
 * so they stay allowed.
 *
 * There is no CLI flag that disables only background Bash, and
 * `--disallowedTools` is ignored under `--dangerously-skip-permissions` (the
 * task lane's mode), but hooks still fire there. So the task-lane seed writes
 * a user-level PreToolUse hook into the per-run HOME that blocks (exit 2) a
 * Bash call with `run_in_background: true` and every Monitor call.
 *
 * The commands are self-contained shell (no file in the PR checkout or the
 * battery install is referenced). The Bash guard needs `jq`; when jq is
 * missing, or the hook input does not parse, it fails OPEN (exit 0) — a broken
 * guard must never block every Bash call.
 */

export const FOREGROUND_ONLY_BASH_MESSAGE =
  "Background commands are killed when this headless session ends. " +
  "Run it in the foreground (no run_in_background) and wait for it; " +
  "for parallel work use a sub-agent.";

export const FOREGROUND_ONLY_MONITOR_MESSAGE =
  "Monitor is unavailable in this headless session: anything it watches is " +
  "killed when the session ends. Run the command in the foreground and wait " +
  "for it; for parallel work use a sub-agent.";

// Both messages are embedded in single quotes below: keep them free of `'`
// (asserted by the tests).

/** PreToolUse(Bash): block run_in_background == true; fail open without jq. */
export const FOREGROUND_ONLY_BASH_COMMAND =
  "command -v jq >/dev/null 2>&1 || exit 0; " +
  "if jq -e '.tool_input.run_in_background == true' >/dev/null 2>&1; then " +
  `echo '${FOREGROUND_ONLY_BASH_MESSAGE}' >&2; exit 2; fi; exit 0`;

/** PreToolUse(Monitor): always block. */
export const FOREGROUND_ONLY_MONITOR_COMMAND = `echo '${FOREGROUND_ONLY_MONITOR_MESSAGE}' >&2; exit 2`;

interface HookCommand {
  type: "command";
  command: string;
}

interface HookMatcherEntry {
  matcher: string;
  hooks: HookCommand[];
}

export const FOREGROUND_ONLY_PRE_TOOL_USE: readonly HookMatcherEntry[] = [
  {
    matcher: "Bash",
    hooks: [{ type: "command", command: FOREGROUND_ONLY_BASH_COMMAND }],
  },
  {
    matcher: "Monitor",
    hooks: [{ type: "command", command: FOREGROUND_ONLY_MONITOR_COMMAND }],
  },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `existing` with the foreground-only PreToolUse entries merged in. Every
 * other key, every other hook event and every existing PreToolUse entry is
 * kept; an entry already present (a retry into the same HOME) is not
 * duplicated. A non-object `hooks` or non-array `PreToolUse` is replaced.
 * Pure: never mutates `existing`.
 */
export function mergeForegroundOnlySettings(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const hooks = isPlainObject(existing.hooks) ? existing.hooks : {};
  const current = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const present = new Set(current.map((entry) => JSON.stringify(entry)));
  const added = FOREGROUND_ONLY_PRE_TOOL_USE.filter(
    (entry) => !present.has(JSON.stringify(entry)),
  ).map((entry) => ({
    matcher: entry.matcher,
    hooks: entry.hooks.map((h) => ({ ...h })),
  }));
  return {
    ...existing,
    hooks: { ...hooks, PreToolUse: [...current, ...added] },
  };
}
