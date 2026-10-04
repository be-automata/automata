import type {
  DaemonReviewAgentWire,
  PulledDaemonMessage,
  ReviewAgentShape,
} from "./types";

/**
 * Worker → daemon `reviewAgent` wire (Phase 5, D2).
 *
 * The worker stamps the minimal `{ mode, commandTimeoutMs, maxTurns? }` onto
 * the pulled `claude` message ONLY for an in-bounds orchestrated PR-review
 * run. runTests / runTestsDowngradedReason / batteries never cross this wire:
 * the prompt is built control-plane-side (Phase 6) and the batteries are
 * seeded by the worker itself. Bounds mirror the Phase 4 admin ranges and are
 * checked here AND by the daemon (defense in depth).
 */

/** Phase 4 REVIEW_COMMAND_TIMEOUT 60..600 s, in ms. Mirrored, not imported. */
export const REVIEW_WIRE_COMMAND_TIMEOUT_MS_RANGE: readonly [number, number] = [
  60000, 600000,
];
/** Phase 4 MAX_TURNS 1..500. Mirrored, not imported. */
export const REVIEW_WIRE_MAX_TURNS_RANGE: readonly [number, number] = [1, 500];

export type DaemonReviewAgentWireResult =
  | { kind: "none" }
  | { kind: "wire"; wire: DaemonReviewAgentWire }
  | { kind: "rejected"; reason: string };

function outOfRange(
  value: number,
  [min, max]: readonly [number, number],
): boolean {
  return !Number.isInteger(value) || value < min || value > max;
}

/** The failing field and its bound, or undefined. Never echoes other fields. */
function findBoundsError(reviewAgent: ReviewAgentShape): string | undefined {
  const [tMin, tMax] = REVIEW_WIRE_COMMAND_TIMEOUT_MS_RANGE;
  if (
    outOfRange(
      reviewAgent.commandTimeoutMs,
      REVIEW_WIRE_COMMAND_TIMEOUT_MS_RANGE,
    )
  ) {
    return `commandTimeoutMs must be an integer in ${tMin}..${tMax}`;
  }
  const [mMin, mMax] = REVIEW_WIRE_MAX_TURNS_RANGE;
  if (
    reviewAgent.maxTurns !== undefined &&
    outOfRange(reviewAgent.maxTurns, REVIEW_WIRE_MAX_TURNS_RANGE)
  ) {
    return `maxTurns must be an integer in ${mMin}..${mMax}`;
  }
  return undefined;
}

/**
 * The run's effective review shape, decided BEFORE seeding: an orchestrated
 * reviewAgent that fails the bounds check is dropped, so the run seeds AND
 * runs classic and its `batteries:` line says what actually runs.
 */
export function reviewAgentForRun(reviewAgent: ReviewAgentShape | undefined): {
  reviewAgent?: ReviewAgentShape;
  rejected?: string;
} {
  if (!reviewAgent) {
    return {};
  }
  if (reviewAgent.mode === "orchestrated") {
    const rejected = findBoundsError(reviewAgent);
    if (rejected !== undefined) {
      return { rejected };
    }
  }
  return { reviewAgent };
}

export function buildDaemonReviewAgentWire(
  reviewAgent: ReviewAgentShape | undefined,
  permissionMode: PulledDaemonMessage["permissionMode"],
): DaemonReviewAgentWireResult {
  if (permissionMode !== "review" || reviewAgent?.mode !== "orchestrated") {
    return { kind: "none" };
  }
  const reason = findBoundsError(reviewAgent);
  if (reason !== undefined) {
    return { kind: "rejected", reason };
  }
  return {
    kind: "wire",
    wire:
      reviewAgent.maxTurns !== undefined
        ? {
            mode: "orchestrated",
            commandTimeoutMs: reviewAgent.commandTimeoutMs,
            maxTurns: reviewAgent.maxTurns,
          }
        : {
            mode: "orchestrated",
            commandTimeoutMs: reviewAgent.commandTimeoutMs,
          },
  };
}

/**
 * None/rejected ⇒ the SAME message reference (byte-identical JSON on the
 * socket); wire ⇒ a new message with `reviewAgent` set. Never mutates.
 */
export function withReviewAgentWire(
  message: PulledDaemonMessage,
  reviewAgent: ReviewAgentShape | undefined,
): { message: PulledDaemonMessage; rejected?: string } {
  const built = buildDaemonReviewAgentWire(reviewAgent, message.permissionMode);
  if (built.kind === "wire") {
    return { message: { ...message, reviewAgent: built.wire } };
  }
  if (built.kind === "rejected") {
    return { message, rejected: built.reason };
  }
  return { message };
}
