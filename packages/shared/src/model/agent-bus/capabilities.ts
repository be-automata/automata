import type { ThreadStatus } from "../../db/types";

/**
 * Pure policy for the agent bus (#659, S1): what a run may spawn, message and
 * touch. A lane is a name for a capability set, persisted per run; a child's
 * set is the parent's intersected with what it asks for. No database access
 * and no runtime import of the schema.
 */

export type AgentBusLane = "task" | "review";

export interface AgentRepoGrant {
  repo: string;
  access: "read" | "write";
}

export interface AgentCapabilities {
  spawn: AgentBusLane[];
  sendTo: AgentBusLane[];
  repoGrant: AgentRepoGrant[];
  /** null = unrestricted. */
  skills: string[] | null;
  maxDepth: number;
}

const AGENT_BUS_LANES: readonly string[] = ["task", "review"];

function isLaneList(value: unknown): value is AgentBusLane[] {
  return (
    Array.isArray(value) && value.every((l) => AGENT_BUS_LANES.includes(l))
  );
}

/**
 * Narrows a stored `capabilities` value. The jsonb column is typed, not checked,
 * so a row is validated on read: a malformed set must fail closed, never lift a
 * limit (a missing `maxDepth` would otherwise compare as NaN and allow any depth).
 */
export function isAgentCapabilities(
  value: unknown,
): value is AgentCapabilities {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isLaneList(v.spawn) &&
    isLaneList(v.sendTo) &&
    Array.isArray(v.repoGrant) &&
    v.repoGrant.every(
      (g: unknown) =>
        typeof g === "object" &&
        g !== null &&
        typeof (g as Record<string, unknown>).repo === "string" &&
        ["read", "write"].includes(
          (g as Record<string, unknown>).access as string,
        ),
    ) &&
    (v.skills === null ||
      (Array.isArray(v.skills) &&
        v.skills.every((s: unknown) => typeof s === "string"))) &&
    Number.isInteger(v.maxDepth) &&
    (v.maxDepth as number) >= 0
  );
}

/** A run as the bus sees it: the ledger row plus its thread's effective status. */
export interface AgentRunView {
  threadId: string;
  organizationId: string;
  parentThreadId: string | null;
  rootThreadId: string;
  lane: AgentBusLane;
  capabilities: AgentCapabilities;
  depth: number;
  status: ThreadStatus;
  terminal: boolean;
  blockedAt: Date | null;
}

export type AgentBusError =
  | "not_found"
  | `lane_pair_not_allowed:${AgentBusLane}->${AgentBusLane}`
  | "target_not_running"
  | "sender_not_running"
  | "agent_blocked"
  | "repo_not_granted"
  | "skill_not_granted"
  | "depth_exceeded"
  | "run_exists";

export type AgentBusState =
  | "starting"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export const LANE_DEFAULT_MAX_DEPTH = 3;

const LANE_DEFAULT_REACH: Record<AgentBusLane, AgentBusLane[]> = {
  task: ["task", "review"],
  review: [],
};

/** The capability set a lane starts from, before any narrowing. */
export function capabilitiesForLane(
  lane: AgentBusLane,
  grant: { repoGrant: AgentRepoGrant[]; skills: string[] | null },
): AgentCapabilities {
  return {
    spawn: [...LANE_DEFAULT_REACH[lane]],
    sendTo: [...LANE_DEFAULT_REACH[lane]],
    repoGrant: grant.repoGrant.map((g) => ({ ...g })),
    skills: grant.skills === null ? null : [...grant.skills],
    maxDepth: LANE_DEFAULT_MAX_DEPTH,
  };
}

export type NarrowResult =
  | { ok: true; capabilities: AgentCapabilities; depth: number }
  | { ok: false; error: AgentBusError };

function intersect<T>(a: T[], b: T[]): T[] {
  return a.filter((x) => b.includes(x));
}

/**
 * The capabilities and depth of a child asked for by `parent`, or the reason
 * it is refused. The child is never wider than the parent: spawn and sendTo are
 * the lane default intersected with the parent's, the repo grant is one
 * read-only entry from the parent's grant, skills are a subset of the parent's,
 * and maxDepth is the lane default capped by the parent's.
 */
export function narrowForChild(
  parent: {
    lane: AgentBusLane;
    capabilities: AgentCapabilities;
    depth: number;
  },
  request: { lane: AgentBusLane; repo?: string; skills?: string[] },
): NarrowResult {
  const parentCaps = parent.capabilities;

  if (!parentCaps.spawn.includes(request.lane)) {
    return {
      ok: false,
      error: `lane_pair_not_allowed:${parent.lane}->${request.lane}`,
    };
  }

  const wanted = (request.repo ?? parentCaps.repoGrant[0]?.repo)?.toLowerCase();
  const granted =
    wanted === undefined
      ? undefined
      : parentCaps.repoGrant.find((g) => g.repo.toLowerCase() === wanted);
  if (!granted) {
    return { ok: false, error: "repo_not_granted" };
  }

  let skills: string[] | null;
  if (request.skills === undefined) {
    skills = parentCaps.skills === null ? null : [...parentCaps.skills];
  } else {
    const allowed = parentCaps.skills;
    if (allowed !== null && !request.skills.every((s) => allowed.includes(s))) {
      return { ok: false, error: "skill_not_granted" };
    }
    skills = [...request.skills];
  }

  const maxDepth = Math.min(LANE_DEFAULT_MAX_DEPTH, parentCaps.maxDepth);
  const depth = parent.depth + 1;
  // Fails closed: a non-integer limit (NaN from a malformed set) refuses.
  if (!Number.isInteger(maxDepth) || depth > maxDepth) {
    return { ok: false, error: "depth_exceeded" };
  }

  const base = capabilitiesForLane(request.lane, {
    repoGrant: [{ repo: granted.repo, access: "read" }],
    skills,
  });
  return {
    ok: true,
    capabilities: {
      ...base,
      spawn: intersect(base.spawn, parentCaps.spawn),
      sendTo: intersect(base.sendTo, parentCaps.sendTo),
      maxDepth,
    },
    depth,
  };
}

/**
 * Whether `from` may message `to`, checked in this order: another tree, org or
 * absent id is `not_found` (identical to absent); a terminal or blocked sender;
 * lane pair (a run may always message its parent); terminal target; blocked
 * target.
 */
export function authorizeSend(
  from: AgentRunView,
  to: AgentRunView | null,
): "ok" | AgentBusError {
  if (
    to === null ||
    to.organizationId !== from.organizationId ||
    to.rootThreadId !== from.rootThreadId
  ) {
    return "not_found";
  }
  if (from.terminal) return "sender_not_running";
  if (from.blockedAt !== null) return "agent_blocked";
  if (
    !from.capabilities.sendTo.includes(to.lane) &&
    to.threadId !== from.parentThreadId
  ) {
    return `lane_pair_not_allowed:${from.lane}->${to.lane}`;
  }
  if (to.terminal) return "target_not_running";
  if (to.blockedAt !== null) return "agent_blocked";
  return "ok";
}

function stateOfStatus(status: ThreadStatus): AgentBusState {
  switch (status) {
    case "draft":
    case "scheduled":
    case "queued":
    case "queued-blocked":
    case "queued-tasks-concurrency":
    case "queued-sandbox-creation-rate-limit":
    case "queued-agent-rate-limit":
    case "booting":
      return "starting";
    case "working":
    case "stopping":
    case "working-error":
    case "working-done":
    case "checkpointing":
      return "running";
    case "complete":
      return "done";
    case "error":
      return "failed";
    case "stopped":
    case "working-stopped":
      return "cancelled";
    default: {
      const unreachable: never = status;
      throw new Error(`Unmapped thread status: ${String(unreachable)}`);
    }
  }
}

/**
 * The bus state of a run. A terminal thread keeps its terminal state (a
 * terminal cause on a non-terminal status reads as `failed`); otherwise a set
 * `blockedAt` wins over the status.
 */
export function busStateOf(
  status: ThreadStatus,
  blockedAt: Date | null,
  terminal: boolean,
): AgentBusState {
  const state = stateOfStatus(status);
  const settled =
    state === "done" || state === "failed" || state === "cancelled";
  if (settled) return state;
  if (terminal) return "failed";
  return blockedAt !== null ? "blocked" : state;
}
