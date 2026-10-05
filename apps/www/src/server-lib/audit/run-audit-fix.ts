import type { DB } from "@terragon/shared/db";
import type { AutomationTriggerType } from "@terragon/shared/automations";
import type {
  AuditFindingRow,
  AuditFixAttemptRow,
} from "@terragon/shared/model/audit-findings";
import {
  bindFixAttemptThread,
  closeFixAttempt,
  refundFixAttempt,
} from "@terragon/shared/model/audit-fix-attempts";
import {
  releaseSelfHealSlot,
  setSlotHolderThread,
} from "@terragon/shared/model/self-heal-slot";

import { getPostHogServer } from "@/lib/posthog-server";

import { logSelfHealDecision } from "./decision-log";
import { buildFixRunTransform } from "./fix-run-prompt";
import { errorText } from "./audit-shared";

/**
 * Turn one claimed fix attempt into exactly one fix thread (RACE-01, SC2).
 *
 * The attempt id rides on the thread's automation-skill stamp, so the
 * dispatch planner can bind the attempt before this function does; the bind
 * here is the idempotent second half of that CAS. A failed thread creation
 * refunds the attempt and frees the pre-holder slot. This never throws.
 *
 * The audit-fix automation is run through runAutomation directly (never the
 * issue-webhook path): no eyes reaction, no author lookup, no GitHub call.
 */

export const SELF_HEAL_FIX_DISPATCH_EVENT = "self_heal_fix_dispatch";

type RunAutomationFn =
  (typeof import("@/server-lib/automations"))["runAutomation"];

export interface RunAuditFixDeps {
  validateCanRun: (args: {
    userId: string;
    automationId: string;
    triggerTypes: AutomationTriggerType[];
    throwOnError: false;
  }) => Promise<{ canRun: boolean }>;
  runAutomation: RunAutomationFn;
  bindFixAttemptThread: typeof bindFixAttemptThread;
  refundFixAttempt: typeof refundFixAttempt;
  closeFixAttempt: typeof closeFixAttempt;
  setSlotHolderThread: typeof setSlotHolderThread;
  releaseSelfHealSlot: typeof releaseSelfHealSlot;
  log: (line: string) => void;
  error: (message: string, fields: Record<string, unknown>) => void;
  capture: (event: string, properties: Record<string, string>) => void;
  now: () => Date;
}

export function defaultRunAuditFixDeps(distinctId: string): RunAuditFixDeps {
  return {
    // Dynamic: automations.ts drags the thread-creation graph; load it only
    // when a fix run actually starts (the cron.ts precedent).
    validateCanRun: async (args) => {
      const { validateCanRunAutomation } = await import(
        "@/server-lib/automations"
      );
      return validateCanRunAutomation(args);
    },
    runAutomation: async (args) => {
      const { runAutomation } = await import("@/server-lib/automations");
      return runAutomation(args);
    },
    bindFixAttemptThread,
    refundFixAttempt,
    closeFixAttempt,
    setSlotHolderThread,
    releaseSelfHealSlot,
    log: (line) => console.log(line),
    error: (message, fields) => console.error(message, fields),
    capture: (event, properties) =>
      getPostHogServer().capture({ distinctId, event, properties }),
    now: () => new Date(),
  };
}

export async function runAuditFixAutomation({
  db,
  automation,
  finding,
  attempt,
  baseBranch,
  deps = defaultRunAuditFixDeps(automation.userId),
}: {
  db: DB;
  automation: { id: string; userId: string };
  finding: AuditFindingRow;
  attempt: AuditFixAttemptRow;
  baseBranch: string;
  deps?: RunAuditFixDeps;
}): Promise<{ threadId: string } | null> {
  const organizationId = attempt.organizationId;
  const decide = (reason: string) => {
    try {
      logSelfHealDecision(
        { log: deps.log, capture: deps.capture },
        {
          organizationId,
          repoFullName: finding.repoFullName,
          runId: attempt.id,
          fingerprint: finding.fingerprint,
          decision: "dispatch",
          reason,
          mode: "on",
        },
      );
    } catch (error) {
      deps.error("[self-heal] decision log failed", {
        error: errorText(error),
      });
    }
  };

  /** Nothing started: free the attempt (refund or counted close) and the slot. */
  const abandon = async (
    finish: () => Promise<unknown>,
    reason: string,
    fields: Record<string, unknown>,
  ): Promise<null> => {
    deps.error(`[self-heal] fix dispatch failed: ${reason}`, {
      attemptId: attempt.id,
      findingId: finding.id,
      ...fields,
    });
    try {
      await finish();
    } catch (error) {
      deps.error("[self-heal] could not release the fix attempt", {
        attemptId: attempt.id,
        error: errorText(error),
      });
    }
    try {
      await deps.releaseSelfHealSlot({ db });
    } catch (error) {
      deps.error("[self-heal] could not release the self-heal slot", {
        attemptId: attempt.id,
        error: errorText(error),
      });
    }
    decide(reason);
    return null;
  };
  const refund = (cause: string) => () =>
    deps.refundFixAttempt({
      db,
      organizationId,
      attemptId: attempt.id,
      cause,
      now: deps.now(),
    });

  // The platform section comes from the DB snapshot only; a snapshot that
  // cannot support a fix will not get better by retrying, so it is counted.
  let transformMessage: ReturnType<typeof buildFixRunTransform>;
  try {
    if (finding.issueNumber === null) {
      throw new Error("finding has no issue number");
    }
    transformMessage = buildFixRunTransform({
      finding,
      attemptNo: attempt.attemptNo,
      issueNumber: finding.issueNumber,
      baseBranch,
    });
  } catch (error) {
    return abandon(
      () =>
        deps.closeFixAttempt({
          db,
          organizationId,
          attemptId: attempt.id,
          outcome: "invalid_snapshot",
          counted: true,
          terminalCause: "fix_prompt_invalid",
          now: deps.now(),
        }),
      "invalid_snapshot",
      { error: errorText(error) },
    );
  }

  try {
    const { canRun } = await deps.validateCanRun({
      userId: automation.userId,
      automationId: automation.id,
      triggerTypes: ["issue"],
      throwOnError: false,
    });
    if (!canRun) {
      return abandon(refund("automation_cannot_run"), "automation_cannot_run", {
        automationId: automation.id,
      });
    }
  } catch (error) {
    return abandon(refund("automation_cannot_run"), "automation_cannot_run", {
      automationId: automation.id,
      error: errorText(error),
    });
  }

  let started: Awaited<ReturnType<RunAutomationFn>>;
  try {
    started = await deps.runAutomation({
      userId: automation.userId,
      automationId: automation.id,
      source: "automated",
      options: {
        branchName: baseBranch,
        issueNumber: finding.issueNumber,
        transformMessage,
        stampExtra: { selfHealAttemptId: attempt.id },
      },
    });
  } catch (error) {
    return abandon(refund("thread_create_failed"), "thread_create_failed", {
      error: errorText(error),
    });
  }
  if (!started) {
    return abandon(refund("thread_create_failed"), "thread_create_failed", {
      error: "runAutomation created no thread",
    });
  }
  const { threadId } = started;

  // The thread exists from here on: it holds the box until it is terminal.
  let bound = false;
  try {
    bound = await deps.bindFixAttemptThread({
      db,
      organizationId,
      attemptId: attempt.id,
      threadId,
      now: deps.now(),
    });
  } catch (error) {
    deps.error("[self-heal] fix attempt bind failed", {
      attemptId: attempt.id,
      threadId,
      error: errorText(error),
    });
  }
  try {
    const held = await deps.setSlotHolderThread({
      db,
      threadId,
      now: deps.now(),
    });
    if (!held) {
      deps.error("[self-heal] fix run started but its slot lease had lapsed", {
        attemptId: attempt.id,
        threadId,
      });
    }
  } catch (error) {
    deps.error("[self-heal] could not record the slot holder", {
      attemptId: attempt.id,
      threadId,
      error: errorText(error),
    });
  }
  if (!bound) {
    // The attempt left 'claimed' (refunded or closed) before the bind: the
    // dispatch is aborted; the planner refuses an unbound attempt.
    decide("bind_lost");
    return null;
  }

  decide("started");
  try {
    deps.capture(SELF_HEAL_FIX_DISPATCH_EVENT, {
      organizationId,
      repoFullName: finding.repoFullName,
      findingId: finding.id,
      attemptId: attempt.id,
      attemptNo: String(attempt.attemptNo),
      threadId,
    });
  } catch (error) {
    deps.error("[self-heal] analytics capture failed", {
      error: errorText(error),
    });
  }
  return { threadId };
}
