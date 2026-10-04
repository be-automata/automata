import { ID_OR_NAME } from "./batteries-manifest";
import {
  formatBatteriesLine,
  type SeedBatteriesResult,
} from "./batteries-seed";
import type { RunLane } from "./run-lane";
import type { AgentRunInput, ReviewAgentShape } from "./types";

/**
 * Worker-side gate for task-run packs (Phase 7).
 *
 * The control plane resolves which packs a non-review run gets
 * (resolve-task-agent.ts) and ships them as `input.taskAgent`; the worker only
 * bounds-checks the SHAPE before anything reaches the filesystem (the ADR-003
 * mirror rule: wire values are re-checked at the trust boundary, never
 * re-resolved). The review lane never takes task packs, whatever arrives.
 * Well-formed but unknown ids pass: seedBatteries skips them against the
 * verified manifest, which is the authority on pack ids.
 *
 * Rejection reasons name the rule and the index only — never the value.
 *
 * This module also owns the rest of the task lane's run-time decisions: which
 * packs seed the HOME (batterySeedForRun), whether the agent gets the
 * read-only GitHub token (readTokenForRun), and the log lines that report
 * both (taskRunOutcome).
 */

export const TASK_AGENT_MAX_PACKS = 16;

export type TaskAgentGate =
  | { kind: "none" }
  | { kind: "seed"; batteries: string[]; lane: "task" | "pr" }
  | { kind: "rejected"; lane: "task" | "pr" | "review"; reason: string };

function findShapeError(taskAgent: unknown): string | undefined {
  if (typeof taskAgent !== "object" || taskAgent === null) {
    return "taskAgent must be an object";
  }
  const batteries: unknown = (taskAgent as { batteries?: unknown }).batteries;
  if (!Array.isArray(batteries)) {
    return "batteries must be an array";
  }
  if (batteries.length === 0) {
    return "batteries must not be empty";
  }
  if (batteries.length > TASK_AGENT_MAX_PACKS) {
    return `batteries must hold at most ${TASK_AGENT_MAX_PACKS} ids`;
  }
  const seen = new Set<string>();
  for (const [i, id] of batteries.entries()) {
    if (typeof id !== "string") {
      return `batteries[${i}] must be a string`;
    }
    if (!ID_OR_NAME.test(id)) {
      return `batteries[${i}] must match ${ID_OR_NAME.source}`;
    }
    if (seen.has(id)) {
      return `batteries[${i}] is a duplicate`;
    }
    seen.add(id);
  }
  return undefined;
}

/** `lane` is the run's resolveRunLane(input), computed once by the caller. */
export function taskAgentForRun(
  taskAgent: AgentRunInput["taskAgent"],
  lane: RunLane,
): TaskAgentGate {
  if (taskAgent === undefined) {
    return { kind: "none" };
  }
  if (lane === "review") {
    return { kind: "rejected", lane, reason: "review-lane" };
  }
  const reason = findShapeError(taskAgent);
  if (reason !== undefined) {
    return { kind: "rejected", lane, reason };
  }
  return { kind: "seed", batteries: [...taskAgent.batteries], lane };
}

/** What seedBatteries links into a run's HOME, and whether hooks go off. */
export interface BatterySeed {
  batteries: readonly string[];
  /** true = an orchestrated review (settings.json disableAllHooks). */
  hooksOff: boolean;
  /**
   * Task runs only: install the foreground-only PreToolUse hooks (block
   * background Bash and Monitor, which die when the headless session ends).
   * Absent on review seeds, so their seed is unchanged.
   */
  foregroundOnly?: true;
}

/**
 * The run's battery seed, or undefined (HOME exactly as before). An
 * ORCHESTRATED review seeds its packs with hooks off; otherwise a task gate
 * that seeds links its packs with hooks on, plus the foreground-only
 * PreToolUse guard (the repo's own hooks keep today's semantics). The review
 * wins when both are
 * present (the dispatcher never sends both).
 */
export function batterySeedForRun(
  reviewAgent: Pick<ReviewAgentShape, "mode" | "batteries"> | undefined,
  taskGate: TaskAgentGate,
): BatterySeed | undefined {
  if (reviewAgent?.mode === "orchestrated") {
    return { batteries: reviewAgent.batteries, hooksOff: true };
  }
  if (taskGate.kind === "seed" && taskGate.batteries.length > 0) {
    return {
      batteries: taskGate.batteries,
      hooksOff: false,
      foregroundOnly: true,
    };
  }
  return undefined;
}

/** Why a run does NOT get the read-only task token (phase 7). */
export type ReadTokenSkip =
  | "review-lane"
  | "no-requiring-pack"
  | "not-delivered"
  | "expired"
  | "no-broker";

/** Refuse a token that expires within this margin of the gate (fail closed). */
const READ_TOKEN_EXPIRY_MARGIN_MS = 60_000;

/**
 * Phase 7 (DORA auth = Option 3): whether this run's agent gets the read-only,
 * single-repo GitHub token in GITHUB_TOKEN. ALL must hold:
 * - not the review lane (the #81/ADR-004 fence: a forged field is refused);
 * - the task gate seeded AND seeding succeeded AND a seeded pack's OWN
 *   manifest entry requires `github-read-token` (not only www's decision);
 * - the token was delivered (non-empty);
 * - it is not expired: an expiry within 1 minute, in the past or unparseable
 *   fails closed; an absent expiry is allowed (GitHub caps the token at 1h);
 * - the run is brokered (legacy runs already carry the installation token).
 * Pure; the caller logs the outcome (never the value).
 */
export function readTokenForRun({
  lane,
  taskGate,
  seeded,
  input,
  brokered,
  now,
}: {
  lane: RunLane;
  taskGate: TaskAgentGate;
  seeded: SeedBatteriesResult | undefined;
  input: Pick<AgentRunInput, "githubReadToken" | "githubReadTokenExpiresAt">;
  /** The run's credential brokers are on (config.credentialBroker). */
  brokered: boolean;
  now: number;
}): { token: string } | { skip: ReadTokenSkip } {
  if (lane === "review") {
    return { skip: "review-lane" };
  }
  if (
    taskGate.kind !== "seed" ||
    !seeded?.ok ||
    !(seeded.requires ?? []).includes("github-read-token")
  ) {
    return { skip: "no-requiring-pack" };
  }
  const token = input.githubReadToken;
  if (typeof token !== "string" || token === "") {
    return { skip: "not-delivered" };
  }
  const expiresAt = input.githubReadTokenExpiresAt;
  if (expiresAt !== undefined) {
    const expiry = Date.parse(expiresAt);
    if (Number.isNaN(expiry) || expiry <= now + READ_TOKEN_EXPIRY_MARGIN_MS) {
      return { skip: "expired" };
    }
  }
  if (!brokered) {
    return { skip: "no-broker" };
  }
  return { token };
}

/** The task lane's run-time outcome: its log lines and the token to apply. */
export interface TaskRunOutcome {
  /** Exactly one `batteries:` line, for EVERY run (formatBatteriesLine). */
  batteriesLine: string;
  /**
   * `task agent: read-token=applied` or `task agent: read-token=skip=<reason>`
   * — ONLY when the task gate seeds, so runs without task packs (every review
   * and every unconfigured repo) log nothing new. Never the token value.
   */
  readTokenLine?: string;
  /** Set only when readTokenForRun returned a token. SECRET: never logged. */
  githubReadToken?: string;
}

/** One call per run, after the HOME is seeded (see TaskRunOutcome). */
export function taskRunOutcome(
  args: Parameters<typeof readTokenForRun>[0],
): TaskRunOutcome {
  const batteriesLine = formatBatteriesLine(args.seeded, args.taskGate);
  if (args.taskGate.kind !== "seed") {
    return { batteriesLine };
  }
  const readToken = readTokenForRun(args);
  if ("token" in readToken) {
    return {
      batteriesLine,
      readTokenLine: "task agent: read-token=applied",
      githubReadToken: readToken.token,
    };
  }
  return {
    batteriesLine,
    readTokenLine: `task agent: read-token=skip=${readToken.skip}`,
  };
}
