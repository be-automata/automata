import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  isTransientOpsAlertFailure,
  postOpsAlert,
} from "@/server-lib/knowledge/ops-alert";
import { cellStep } from "@terragon/shared/db/schema";
import { CELL_MAX_ATTEMPTS } from "@terragon/shared/model/cell-authority";
import { runEffect } from "@terragon/shared/model/control-effects";

/** The attempt number a worker sends: 1 to CELL_MAX_ATTEMPTS. */
export const cellAttemptSchema = z.number().int().min(1).max(CELL_MAX_ATTEMPTS);

/**
 * One ops alert per (stepKey, attempt, effect) through the #652 ledger, so a
 * repeated report sends nothing. Only an attempt that really opened
 * (attempt <= current_attempt of the step) can mint a ledger key: `attempt` is
 * caller-supplied and must not grow the ledger. A transient send failure
 * leaves the intent, so the next call retries it. Never throws.
 */
export async function alertCellStepOnce({
  organizationId,
  stepKey,
  attempt,
  effect,
  text,
  logLabel,
}: {
  organizationId: string;
  stepKey: string;
  attempt: number;
  effect: string;
  text: string;
  logLabel: string;
}): Promise<void> {
  try {
    const [step] = await db
      .select({ currentAttempt: cellStep.currentAttempt })
      .from(cellStep)
      .where(eq(cellStep.stepKey, stepKey))
      .limit(1);
    if (!step || attempt > step.currentAttempt) {
      console.error(`[${logLabel}] skipped_unknown_attempt`, {
        stepKey,
        attempt,
        effect,
      });
      return;
    }
    await runEffect({
      db,
      organizationId,
      mission: "cell-teardown",
      step: stepKey,
      effect,
      outputDigest: String(attempt),
      payload: { text },
      target: {
        // A webhook cannot be read back.
        findByMarker: async () => false,
        apply: async (_key, payload) => {
          const result = await postOpsAlert({ text: payload.text });
          if (result.sent) return;
          if (isTransientOpsAlertFailure(result.reason)) {
            // The intent stays and the next call retries it.
            throw new Error(`ops alert not sent: ${result.reason}`);
          }
          // unconfigured, invalid_url, redirect: retrying cannot fix those.
          console.error(`[${logLabel}] ops alert not sent`, {
            reason: result.reason,
          });
        },
      },
    });
  } catch (error) {
    console.error(`[${logLabel}] ops alert failed`, {
      stepKey,
      attempt,
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }
}
