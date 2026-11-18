import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { withDaemonAuthUnavailable } from "@/lib/daemon-auth-unavailable";
import { authorizeDaemonThreadRequest } from "@/lib/daemon-thread-auth";
import { revokeRetiredDaemonTokenById } from "@/lib/daemon-token";
import {
  alertCellStepOnce,
  cellAttemptSchema,
} from "@/server-lib/cell-ops-alert";
import { waitUntil } from "@/lib/wait-until";
import { revokeAttempt } from "@terragon/shared/model/cell-authority";
import { cellStepKey } from "@terragon/types/cell";

/**
 * POST /api/daemon/cell-teardown (#656 PR-D): the worker's end-of-run calls for
 * an OpenSandbox cell.
 *
 *   { threadId, threadChatId, action: "revoke", attempt }
 *   { threadId, threadChatId, action: "report", attempt, outcome: "clean" }
 *   { threadId, threadChatId, action: "report", attempt, outcome: "incomplete",
 *     failedSteps: [...] }
 *
 * The one route that accepts a token retired by the cell's terminal read
 * (allowRetired). There is no flag gate (a rollback must not strand a live
 * cell's revoke and report) and no provider call. The body is never logged;
 * the event and the alert carry the step key, the attempt and enums only.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Canonical order: the first of a report's failed steps is the one named. */
const FAILED_STEPS = [
  "revoke_attempt",
  "vault",
  "quarantine",
  "delete",
  "survivor",
] as const;
type FailedStep = (typeof FAILED_STEPS)[number];

const idsShape = {
  threadId: z.string().min(1),
  threadChatId: z.string().min(1),
};

const bodySchema = z.union([
  z
    .object({
      ...idsShape,
      action: z.literal("revoke"),
      attempt: cellAttemptSchema,
    })
    .strict(),
  z
    .object({
      ...idsShape,
      action: z.literal("report"),
      attempt: cellAttemptSchema,
      outcome: z.literal("clean"),
    })
    .strict(),
  z
    .object({
      ...idsShape,
      action: z.literal("report"),
      attempt: cellAttemptSchema,
      outcome: z.literal("incomplete"),
      failedSteps: z
        .array(z.enum(FAILED_STEPS))
        .min(1)
        .max(FAILED_STEPS.length)
        .refine((steps) => new Set(steps).size === steps.length),
    })
    .strict(),
]);

function reply(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export const POST = withDaemonAuthUnavailable(async function POST(
  request: NextRequest,
): Promise<NextResponse> {
  const auth = await authorizeDaemonThreadRequest({
    request,
    strictThreadId: true,
    allowRetired: true,
    logLabel: "daemon cell-teardown",
  });
  if (!auth.ok) {
    const response = auth.response;
    response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
    return response;
  }
  const { ctx, threadId, thread } = auth;

  const parsed = bodySchema.safeParse(auth.body);
  if (!parsed.success) return reply({ error: "invalid_body" }, 400);
  const body = parsed.data;
  if (ctx.apiKeyId === null) return reply({ error: "no_run_key" }, 403);
  const apiKeyId = ctx.apiKeyId;
  const stepKey = cellStepKey(apiKeyId);

  if (body.action === "revoke") {
    try {
      const revoked = await revokeAttempt({
        db,
        stepKey,
        attempt: body.attempt,
      });
      return reply({ ok: true, revoked });
    } catch (error) {
      console.error("[cell] cell-teardown revoke failed", {
        threadId,
        stepKey,
        attempt: body.attempt,
        error,
      });
      return reply({ error: "revoke_failed" }, 500);
    }
  }

  if (body.outcome === "clean") {
    console.log("[cell] cell-teardown report", {
      threadId,
      stepKey,
      attempt: body.attempt,
      outcome: "clean",
    });
  } else {
    await reportIncomplete({
      stepKey,
      attempt: body.attempt,
      failedSteps: body.failedSteps,
      organizationId: thread.organizationId ?? null,
    });
  }

  // Only a retired token is deleted: a live one (no terminal read) stays.
  waitUntil(
    revokeRetiredDaemonTokenById({ userId: ctx.userId, apiKeyId }).catch(
      (error) =>
        console.error("[daemon-token] delete of retired token failed", {
          apiKeyId,
          error,
        }),
    ),
  );
  return reply({ ok: true });
});

async function reportIncomplete({
  stepKey,
  attempt,
  failedSteps,
  organizationId,
}: {
  stepKey: string;
  attempt: number;
  failedSteps: FailedStep[];
  organizationId: string | null;
}): Promise<void> {
  const failedStep = FAILED_STEPS.find((step) => failedSteps.includes(step));

  console.error("[cell] cell_teardown_incomplete", {
    event: "cell_teardown_incomplete",
    stepKey,
    attempt,
    failedStep,
    failedSteps,
  });
  // An org-less thread logs the event and sends no alert.
  if (organizationId === null) return;
  await alertCellStepOnce({
    organizationId,
    stepKey,
    attempt,
    effect: "incomplete-alert",
    text: `cell teardown incomplete: step ${stepKey}, attempt ${attempt}, failed ${failedStep}`,
    logLabel: "cell-teardown",
  });
}
