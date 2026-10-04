import {
  REVIEW_AGENT_COMMAND_TIMEOUT_MS_MAX,
  REVIEW_AGENT_COMMAND_TIMEOUT_MS_MIN,
  REVIEW_AGENT_MAX_TURNS_MAX,
  REVIEW_AGENT_MAX_TURNS_MIN,
  type DaemonReviewAgent,
} from "@terragon/daemon/shared";

import type { PulledDaemonMessage, ReviewAgentShape } from "./types";

/**
 * Worker → daemon `reviewAgent` wire (Phase 5, D2).
 *
 * The worker stamps the minimal `{ mode, commandTimeoutMs, maxTurns? }` onto
 * the pulled `claude` message ONLY for an orchestrated PR-review run that
 * passed the bounds gate (reviewAgentForRun). runTests /
 * runTestsDowngradedReason / batteries never cross this wire: the prompt is
 * built control-plane-side (Phase 6) and the batteries are seeded by the
 * worker itself. The bounds are the daemon's own (`@terragon/daemon/shared`)
 * and are checked once here AND by the daemon's zod schema (defense in depth).
 */

function outOfRange(value: number, min: number, max: number): boolean {
  return !Number.isInteger(value) || value < min || value > max;
}

/** The failing field and its bound, or undefined. Never echoes other fields. */
function findBoundsError(reviewAgent: ReviewAgentShape): string | undefined {
  if (
    outOfRange(
      reviewAgent.commandTimeoutMs,
      REVIEW_AGENT_COMMAND_TIMEOUT_MS_MIN,
      REVIEW_AGENT_COMMAND_TIMEOUT_MS_MAX,
    )
  ) {
    return `commandTimeoutMs must be an integer in ${REVIEW_AGENT_COMMAND_TIMEOUT_MS_MIN}..${REVIEW_AGENT_COMMAND_TIMEOUT_MS_MAX}`;
  }
  if (
    reviewAgent.maxTurns !== undefined &&
    outOfRange(
      reviewAgent.maxTurns,
      REVIEW_AGENT_MAX_TURNS_MIN,
      REVIEW_AGENT_MAX_TURNS_MAX,
    )
  ) {
    return `maxTurns must be an integer in ${REVIEW_AGENT_MAX_TURNS_MIN}..${REVIEW_AGENT_MAX_TURNS_MAX}`;
  }
  return undefined;
}

/**
 * The run's effective review shape — the ONE bounds gate, decided BEFORE
 * seeding: an orchestrated reviewAgent that fails the bounds check is
 * dropped, so the run seeds AND runs classic and its `batteries:` line says
 * what actually runs.
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

/**
 * The daemon wire for an orchestrated review run, else undefined. Expects a
 * reviewAgent that already passed reviewAgentForRun.
 */
export function buildDaemonReviewAgentWire(
  reviewAgent: ReviewAgentShape | undefined,
  permissionMode: PulledDaemonMessage["permissionMode"],
): DaemonReviewAgent | undefined {
  if (permissionMode !== "review" || reviewAgent?.mode !== "orchestrated") {
    return undefined;
  }
  const { commandTimeoutMs, maxTurns } = reviewAgent;
  return maxTurns !== undefined
    ? { mode: "orchestrated", commandTimeoutMs, maxTurns }
    : { mode: "orchestrated", commandTimeoutMs };
}

/**
 * No wire ⇒ the SAME message reference (byte-identical JSON on the socket);
 * wire ⇒ a new message with `reviewAgent` set. Never mutates.
 */
export function withReviewAgentWire(
  message: PulledDaemonMessage,
  reviewAgent: ReviewAgentShape | undefined,
): PulledDaemonMessage {
  const wire = buildDaemonReviewAgentWire(reviewAgent, message.permissionMode);
  return wire ? { ...message, reviewAgent: wire } : message;
}
