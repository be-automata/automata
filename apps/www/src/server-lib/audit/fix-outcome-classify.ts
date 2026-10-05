import type { ThreadErrorType } from "@terragon/shared/db/types";
import {
  isTerminalCause,
  type TerminalCause,
} from "@terragon/shared/model/terminal-cause";

/**
 * How a self-heal fix run ended, as far as the finding's attempt budget is
 * concerned (RES-10, RECON-01, KILL-01).
 *
 * WHY refunds exist: a fix attempt is the finding's budget for "the agent
 * tried and could not fix it". When the box wedges, a worker dies, the plane
 * goes offline or the run expires in the queue, the agent never tried — and
 * without a refund one bad hour on the box would burn every ready finding's
 * attempts and mass-label them needs-human-approve. Infra causes are refunded
 * and feed the exec_plane breaker instead, so a box that keeps failing stops
 * the loop rather than eating the backlog.
 *
 * Drain / kill switch (KILL-01): a cancelled run ends refunded with outcome
 * 'killed' — an operator stopping the loop is never the finding's fault.
 *
 * Credential exhaustion (401, revoked or missing login, usage/weekly quota) is
 * deliberately COUNTED and is NOT an exec_plane signal: the operator decided
 * against spend limits and key protection, and an expired or exhausted login
 * is never a breaker trip nor an attempt refund. The attempts cap is what ends
 * a loop that keeps hitting it.
 *
 * Guard and gate failures (scope guard, finding check, CI) are not terminal
 * causes; the gate path decides those (09-11 / 09-12).
 */

export type FixTerminalClass = "infra" | "counted";

export interface FixTerminalClassification {
  class: FixTerminalClass;
  /** Short machine reason, written as the attempt's terminal_cause. */
  reason: string;
  /** Attempt outcome: 'killed' for a Drain/kill, 'refunded' or 'run_failed'. */
  outcome: "killed" | "refunded" | "run_failed";
  /** True when the cause is evidence about the execution plane (BRK-01). */
  execPlaneSignal: boolean;
}

interface CauseRule {
  class: FixTerminalClass;
  reason: string;
  execPlaneSignal: boolean;
}

/**
 * Every typed terminal cause, exhaustively (adding a member to the union fails
 * compilation here). All of them are infrastructure or policy, never the fix:
 * - superseded / discarded / stale-skipped: the engine's supersede policy
 *   abandoned the run (not plane evidence);
 * - user-cancelled: a Drain or an operator cancel → killed;
 * - timeout: scheduleTimeout (expired in the queue) or the execution timeout;
 * - daemon-failed: the daemon died (worker death, OOM, box lock lost,
 *   redelivery exhausted all land here);
 * - plane-offline: dispatched but never visible on the plane;
 * - publish-failed: a GitHub post failed (GitHub breakers own that signal).
 */
export const TERMINAL_CAUSE_RULES = {
  superseded: { class: "infra", reason: "abandoned", execPlaneSignal: false },
  discarded: { class: "infra", reason: "abandoned", execPlaneSignal: false },
  "stale-skipped": {
    class: "infra",
    reason: "abandoned",
    execPlaneSignal: false,
  },
  "user-cancelled": {
    class: "infra",
    reason: "killed",
    execPlaneSignal: false,
  },
  timeout: { class: "infra", reason: "timeout", execPlaneSignal: true },
  "daemon-failed": {
    class: "infra",
    reason: "daemon_failed",
    execPlaneSignal: true,
  },
  "publish-failed": {
    class: "infra",
    reason: "publish_failed",
    execPlaneSignal: false,
  },
  "plane-offline": {
    class: "infra",
    reason: "plane_offline",
    execPlaneSignal: true,
  },
} as const satisfies Record<TerminalCause, CauseRule>;

const CREDENTIAL: CauseRule = {
  class: "counted",
  reason: "credential",
  execPlaneSignal: false,
};

/**
 * Every thread error type, exhaustively. Sandbox/boot/queue failures are the
 * plane's; credential errors are counted (operator decision); what the agent
 * itself produced (errors, prompt too long, setup script, checkpoint push) is
 * counted.
 */
export const THREAD_ERROR_RULES = {
  "request-timeout": {
    class: "infra",
    reason: "request_timeout",
    execPlaneSignal: true,
  },
  "sandbox-not-found": {
    class: "infra",
    reason: "sandbox_lost",
    execPlaneSignal: true,
  },
  "sandbox-creation-failed": {
    class: "infra",
    reason: "sandbox_lost",
    execPlaneSignal: true,
  },
  "sandbox-resume-failed": {
    class: "infra",
    reason: "sandbox_lost",
    execPlaneSignal: true,
  },
  "agent-not-responding": {
    class: "infra",
    reason: "agent_not_responding",
    execPlaneSignal: true,
  },
  "queue-limit-exceeded": {
    class: "infra",
    reason: "queue_limit",
    execPlaneSignal: false,
  },
  "missing-gemini-credentials": CREDENTIAL,
  "missing-amp-credentials": CREDENTIAL,
  "chatgpt-sub-required": CREDENTIAL,
  "invalid-codex-credentials": CREDENTIAL,
  "invalid-claude-credentials": CREDENTIAL,
  "no-user-message": {
    class: "counted",
    reason: "agent_error",
    execPlaneSignal: false,
  },
  "unknown-error": {
    class: "counted",
    reason: "agent_error",
    execPlaneSignal: false,
  },
  "agent-generic-error": {
    class: "counted",
    reason: "agent_error",
    execPlaneSignal: false,
  },
  "git-checkpoint-diff-failed": {
    class: "counted",
    reason: "agent_error",
    execPlaneSignal: false,
  },
  "git-checkpoint-push-failed": {
    class: "counted",
    reason: "agent_error",
    execPlaneSignal: false,
  },
  "setup-script-failed": {
    class: "counted",
    reason: "setup_script_failed",
    execPlaneSignal: false,
  },
  "prompt-too-long": {
    class: "counted",
    reason: "prompt_too_long",
    execPlaneSignal: false,
  },
} as const satisfies Record<ThreadErrorType, CauseRule>;

/** Free-text quota / 401 messages the agents emit (Claude, Codex, the API). */
const CREDENTIAL_TEXT =
  /usage limit|limit reached|quota|credit balance|\b401\b|unauthori[sz]ed|not logged in|invalid api key/i;

/** Statuses a human (or the UI stop button) ends a run in without a cause. */
const STOPPED_STATUSES = new Set(["stopped", "working-stopped"]);

/**
 * Terminal causes (and the two synthetic ones) that are refunded. Every
 * TerminalCause member is infra; `check_missing` is a completed run whose
 * check report never arrived; `killed` is a Drain / kill-switch cancel.
 */
export const INFRA_TERMINAL_CAUSES = [
  ...(Object.keys(TERMINAL_CAUSE_RULES) as TerminalCause[]).filter(
    (c) => TERMINAL_CAUSE_RULES[c].class === "infra",
  ),
  "check_missing",
  "killed",
] as const;

function isThreadErrorType(value: string): value is ThreadErrorType {
  return Object.prototype.hasOwnProperty.call(THREAD_ERROR_RULES, value);
}

function fromRule(rule: CauseRule): FixTerminalClassification {
  if (rule.class === "counted") {
    return {
      class: "counted",
      reason: rule.reason,
      outcome: "run_failed",
      execPlaneSignal: false,
    };
  }
  return {
    class: "infra",
    reason: rule.reason,
    outcome: rule.reason === "killed" ? "killed" : "refunded",
    execPlaneSignal: rule.execPlaneSignal,
  };
}

export interface ClassifyFixTerminalInput {
  terminalCause: string | null;
  /** The thread's error message (a ThreadErrorType or free agent text). */
  errorMessage?: string | null;
  /** The effective thread status, when known. */
  status?: string | null;
  hasCheckReport: boolean;
  /** A Drain / kill-switch cancel ended the run (KILL-01). */
  killed: boolean;
}

/**
 * Classify one terminal fix run. Precedence: killed → a check report exists
 * (the gate owns that attempt; never refunded here) → credential → typed
 * terminal cause → thread error type → free-text error → completed without a
 * report (check_missing) → stopped by a human (killed) → counted.
 */
export function classifyFixTerminal(
  input: ClassifyFixTerminalInput,
): FixTerminalClassification {
  const cause = input.terminalCause;
  const error = input.errorMessage ?? null;

  if (input.killed || cause === "user-cancelled") {
    return fromRule(TERMINAL_CAUSE_RULES["user-cancelled"]);
  }
  if (input.hasCheckReport) {
    return {
      class: "counted",
      reason: "reported",
      outcome: "run_failed",
      execPlaneSignal: false,
    };
  }
  if (error !== null) {
    const credential = isThreadErrorType(error)
      ? THREAD_ERROR_RULES[error].reason === CREDENTIAL.reason
      : CREDENTIAL_TEXT.test(error);
    if (credential) return fromRule(CREDENTIAL);
  }
  if (cause !== null && isTerminalCause(cause)) {
    return fromRule(TERMINAL_CAUSE_RULES[cause]);
  }
  if (error !== null) {
    if (isThreadErrorType(error)) return fromRule(THREAD_ERROR_RULES[error]);
    return fromRule({
      class: "counted",
      reason: "agent_error",
      execPlaneSignal: false,
    });
  }
  if (input.status === "complete") {
    return {
      class: "infra",
      reason: "check_missing",
      outcome: "refunded",
      execPlaneSignal: true,
    };
  }
  if (input.status && STOPPED_STATUSES.has(input.status)) {
    return fromRule(TERMINAL_CAUSE_RULES["user-cancelled"]);
  }
  return {
    class: "counted",
    reason: cause ?? "unknown",
    outcome: "run_failed",
    execPlaneSignal: false,
  };
}
