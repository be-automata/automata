import type { BootingSubstatus } from "@terragon/sandbox/types";

import type { ThreadErrorType, ThreadSource, ThreadStatus } from "../db/types";
import { assertNever } from "../utils";
import { describeTerminalCause, isTerminalCause } from "./terminal-cause";

/**
 * The Ops Desk run-state vocabulary (DESIGN.md "RunState"). Every surface that
 * shows what an agent is doing maps through here, so a state always reads the
 * same word, shape and reason on Home, Automations, Stats and the task list.
 */
export type RunStateKind =
  | "needs-you"
  | "waiting"
  | "running"
  | "done"
  | "unverified";

export interface RunState {
  kind: RunStateKind;
  /** Lowercase status word printed next to the glyph ("working", "queued"). */
  word: string;
  /** Optional plain-language suffix ("waiting for a free slot"). */
  reason: string | null;
}

/** Statuses where an agent is doing work right now. */
export const RUNNING_STATUSES: ThreadStatus[] = [
  "booting",
  "working",
  "stopping",
  "checkpointing",
  "working-done",
];

/** Statuses where a run is accepted but not yet started. */
export const WAITING_STATUSES: ThreadStatus[] = [
  "queued",
  "queued-tasks-concurrency",
  "queued-sandbox-creation-rate-limit",
  "queued-agent-rate-limit",
  "queued-blocked",
];

/** Statuses that mean the run ended badly. */
export const ERROR_STATUSES: ThreadStatus[] = ["working-error", "error"];

/** Typed terminal causes that are failures someone should look at. */
export const FAILURE_TERMINAL_CAUSES = [
  "daemon-failed",
  "publish-failed",
  "plane-offline",
  "timeout",
] as const;

function statusWord(status: ThreadStatus): string {
  switch (status) {
    case "draft":
      return "draft";
    case "scheduled":
      return "scheduled";
    case "queued":
    case "queued-tasks-concurrency":
    case "queued-sandbox-creation-rate-limit":
    case "queued-agent-rate-limit":
    case "queued-blocked":
      return "queued";
    case "booting":
      return "booting";
    case "working":
      return "working";
    case "stopping":
      return "stopping";
    case "checkpointing":
    case "working-done":
      return "finishing";
    case "complete":
      return "done";
    case "working-stopped":
    case "stopped":
      return "stopped";
    case "working-error":
    case "error":
      return "error";
    default:
      return assertNever(status);
  }
}

function waitingReason(status: ThreadStatus): string | null {
  switch (status) {
    case "queued-tasks-concurrency":
      return "waiting for a free slot";
    case "queued-sandbox-creation-rate-limit":
      return "sandbox rate limit";
    case "queued-agent-rate-limit":
      return "agent rate limit";
    case "queued-blocked":
      return "blocked";
    default:
      return null;
  }
}

function bootingReason(substatus: BootingSubstatus | null): string | null {
  switch (substatus) {
    case null:
      return null;
    case "provisioning":
    case "provisioning-done":
      return "starting sandbox";
    case "cloning-repo":
      return "cloning repo";
    case "installing-agent":
      return "installing agent";
    case "installing-sandbox-scripts":
      return "preparing sandbox";
    case "running-setup-script":
      return "running setup script";
    case "booting-done":
      return null;
    default:
      return assertNever(substatus);
  }
}

/**
 * The run state for a thread's effective status. Pass `hasError` whenever the
 * thread carries an error message: running and waiting states still win, so a
 * live run with a stale message keeps reading as running.
 */
export function runStateFor({
  status,
  hasError = false,
  terminalCause = null,
  bootingSubstatus = null,
}: {
  status: ThreadStatus;
  hasError?: boolean;
  terminalCause?: string | null;
  bootingSubstatus?: BootingSubstatus | null;
}): RunState {
  if (RUNNING_STATUSES.includes(status)) {
    return {
      kind: "running",
      word: statusWord(status),
      reason: status === "booting" ? bootingReason(bootingSubstatus) : null,
    };
  }
  if (WAITING_STATUSES.includes(status)) {
    return { kind: "waiting", word: "queued", reason: waitingReason(status) };
  }
  const failedCause =
    terminalCause !== null &&
    (FAILURE_TERMINAL_CAUSES as readonly string[]).includes(terminalCause);
  if (ERROR_STATUSES.includes(status) || hasError || failedCause) {
    return {
      kind: "needs-you",
      word: "error",
      reason:
        terminalCause && isTerminalCause(terminalCause)
          ? describeTerminalCause(terminalCause).label.toLowerCase()
          : null,
    };
  }
  if (terminalCause && isTerminalCause(terminalCause)) {
    return {
      kind: "unverified",
      word: describeTerminalCause(terminalCause).label.toLowerCase(),
      reason: null,
    };
  }
  if (status === "complete") {
    return { kind: "done", word: "done", reason: null };
  }
  return { kind: "unverified", word: statusWord(status), reason: null };
}

/** Where a "needs you" row sends the viewer; navigation only. */
export type NeedsYouAction = "open-task" | "reconnect-credential";

export interface NeedsYouExplanation {
  title: string;
  reason: string;
  action: NeedsYouAction;
}

function explainErrorType(error: ThreadErrorType): NeedsYouExplanation {
  switch (error) {
    case "invalid-claude-credentials":
    case "invalid-codex-credentials":
      return {
        title: "Agent credential rejected",
        reason:
          "The agent's credential was rejected, so the run stopped. Reconnect it, then retry.",
        action: "reconnect-credential",
      };
    case "provider-unavailable":
      return {
        title: "Claude subscription unavailable",
        reason:
          "The connected Claude subscription refused the run (a usage limit, disabled access, no credit, or a rejected credential). Retry after it is available again.",
        action: "reconnect-credential",
      };
    case "missing-gemini-credentials":
    case "missing-amp-credentials":
    case "chatgpt-sub-required":
      return {
        title: "Agent credential missing",
        reason:
          "This agent needs a credential that is not connected for this organization.",
        action: "reconnect-credential",
      };
    case "git-checkpoint-push-failed":
      return {
        title: "Push failed",
        reason:
          "The agent could not push its branch. Open the task to see the git error.",
        action: "open-task",
      };
    case "git-checkpoint-diff-failed":
      return {
        title: "Diff failed",
        reason: "The agent's changes could not be read back from the sandbox.",
        action: "open-task",
      };
    case "setup-script-failed":
      return {
        title: "Setup script failed",
        reason:
          "The repository's setup script exited with an error before the agent started.",
        action: "open-task",
      };
    case "sandbox-not-found":
    case "sandbox-creation-failed":
    case "sandbox-resume-failed":
      return {
        title: "Sandbox unavailable",
        reason: "The sandbox could not be created or resumed.",
        action: "open-task",
      };
    case "prompt-too-long":
      return {
        title: "Prompt too long",
        reason:
          "The task is longer than the agent accepts. Shorten it and retry.",
        action: "open-task",
      };
    case "queue-limit-exceeded":
      return {
        title: "Queue full",
        reason: "Too many tasks were queued at once, so this one was dropped.",
        action: "open-task",
      };
    case "queue-retired":
      return {
        title: "Retired from the queue",
        reason:
          "This run waited in the queue until it was stale, so it was retired without running.",
        action: "open-task",
      };
    case "out-of-memory":
      return {
        title: "Ran out of memory",
        reason:
          "The run exceeded its memory limit and was stopped. Reduce parallelism and retry.",
        action: "open-task",
      };
    case "agent-not-responding":
    case "request-timeout":
      return {
        title: "Agent stopped responding",
        reason: "The agent went quiet and the run was stopped.",
        action: "open-task",
      };
    case "no-user-message":
    case "unknown-error":
    case "agent-generic-error":
      return {
        title: "Agent error",
        reason: "The agent stopped with an error.",
        action: "open-task",
      };
    default:
      return assertNever(error);
  }
}

// A Record, so adding a ThreadErrorType without listing it fails to compile.
const THREAD_ERROR_TYPES: Record<ThreadErrorType, true> = {
  "request-timeout": true,
  "no-user-message": true,
  "unknown-error": true,
  "sandbox-not-found": true,
  "sandbox-creation-failed": true,
  "sandbox-resume-failed": true,
  "missing-gemini-credentials": true,
  "missing-amp-credentials": true,
  "chatgpt-sub-required": true,
  "invalid-codex-credentials": true,
  "invalid-claude-credentials": true,
  "agent-not-responding": true,
  "agent-generic-error": true,
  "git-checkpoint-diff-failed": true,
  "git-checkpoint-push-failed": true,
  "setup-script-failed": true,
  "prompt-too-long": true,
  "queue-limit-exceeded": true,
  "provider-unavailable": true,
  "queue-retired": true,
  "out-of-memory": true,
};

function isThreadErrorType(value: string): value is ThreadErrorType {
  return Object.hasOwn(THREAD_ERROR_TYPES, value);
}

/** Plain title, reason and next step for a run that needs someone. */
export function explainNeedsYou({
  errorMessage,
  terminalCause,
}: {
  errorMessage: string | null;
  terminalCause: string | null;
}): NeedsYouExplanation {
  if (errorMessage && isThreadErrorType(errorMessage)) {
    return explainErrorType(errorMessage);
  }
  if (terminalCause && isTerminalCause(terminalCause)) {
    const { label, detail } = describeTerminalCause(terminalCause);
    return { title: label, reason: detail, action: "open-task" };
  }
  return {
    title: "Agent error",
    reason: "The agent stopped with an error.",
    action: "open-task",
  };
}

/** What started a run, for provenance lines and the Stats source split. */
export type TriggerKind = "web" | "automation" | "slack" | "github" | "cli";

export function triggerKindFor({
  sourceType,
  automationId,
}: {
  sourceType: ThreadSource | null;
  automationId: string | null;
}): TriggerKind {
  if (automationId) {
    return "automation";
  }
  switch (sourceType) {
    case null:
    case "www":
    case "www-redo":
    case "www-fork":
    case "www-multi-agent":
    case "www-suggested-followup-task":
      return "web";
    case "automation":
      return "automation";
    case "slack-mention":
      return "slack";
    case "github-mention":
    case "webhook":
      return "github";
    case "cli":
      return "cli";
    default:
      return assertNever(sourceType);
  }
}

export const TRIGGER_LABELS: Record<TriggerKind, string> = {
  web: "Web",
  automation: "Automation",
  slack: "Slack",
  github: "GitHub",
  cli: "CLI",
};

/** Display title without a leading markdown heading marker ("# Audit" → "Audit"). */
export function displayRunTitle(
  name: string | null | undefined,
  fallback = "Untitled task",
): string {
  const trimmed = (name ?? "").replace(/^\s*#{1,6}\s+/, "").trim();
  return trimmed.length > 0 ? trimmed : fallback;
}
