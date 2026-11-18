import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { withDaemonAuthUnavailable } from "@/lib/daemon-auth-unavailable";
import { getThreadChat } from "@terragon/shared/model/threads";
import { finishStep, stampSeen } from "@terragon/shared/model/cell-authority";
import { cellStepKey } from "@terragon/types/cell";
import { isAgentWorking } from "@/agent/thread-status";
import {
  retireDaemonTokenById,
  revokeCellEventTokens,
  revokeDaemonTokenById,
} from "@/lib/daemon-token";
import {
  alertCellStepOnce,
  cellAttemptSchema,
} from "@/server-lib/cell-ops-alert";
import { waitUntil } from "@/lib/wait-until";

/**
 * POST /api/daemon/thread-status   body: { threadId, threadChatId }
 *
 * The remote (Hatchet) worker polls this to know when its agent turn is terminal
 * (ADR-003 slice 2): the daemon streams events to /api/daemon-event and www owns
 * the resulting thread status, so the worker asks www rather than the daemon. Same
 * X-Daemon-Token custody + F1 (tokenType='daemon') + F2 (token↔threadChat binding)
 * as the other daemon endpoints. Returns { status, terminal } — terminal true once
 * the agent is no longer working (complete/error/stopped), the worker's cue to
 * tear the daemon down and clean up.
 *
 * A cell run (#656) also sends `cellAttempt`: a non-terminal poll renews the
 * attempt's lease (`lease`), and the terminal read finishes the cell step,
 * deletes the cell's event-only tokens (#693), and RETIRES the run token
 * instead of deleting it (it stays valid on cell-teardown only, for at most 15
 * minutes). Without `cellAttempt` nothing changes.
 */
export const POST = withDaemonAuthUnavailable(async function POST(
  request: NextRequest,
): Promise<NextResponse> {
  const ctx = await getDaemonTokenContext(request);
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (ctx.tokenType !== "daemon") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: {
    threadId?: unknown;
    threadChatId?: unknown;
    cellAttempt?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const threadId = typeof body.threadId === "string" ? body.threadId : null;
  const threadChatId =
    typeof body.threadChatId === "string" ? body.threadChatId : null;
  if (!threadId || !threadChatId) {
    return NextResponse.json(
      { error: "Missing threadId or threadChatId" },
      { status: 400 },
    );
  }
  // F2: the token is bound to one threadChat.
  if (ctx.threadChatId !== threadChatId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // F2 anchor: bind on threadId too (threadChatId is the shared legacy sentinel
  // when enableThreadChatCreation is off). Legacy tokens (no threadId) pass through.
  // TODO(f2-threadid-unconditional): drop the `ctx.threadId !== null` clause once
  // pre-anchor tokens have cycled (1-day expiry) — see next-message route marker.
  if (ctx.threadId !== null && ctx.threadId !== threadId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // getThreadChat is fenced by userId; null → the token's user doesn't own it.
  const threadChat = await getThreadChat({
    db,
    threadId,
    threadChatId,
    userId: ctx.userId,
  });
  if (!threadChat) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if ((threadChat.organizationId ?? null) !== (ctx.organizationId ?? null)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const terminal = !isAgentWorking(threadChat.status);

  if (body.cellAttempt !== undefined) {
    const parsedAttempt = cellAttemptSchema.safeParse(body.cellAttempt);
    if (!parsedAttempt.success) {
      return NextResponse.json(
        { error: "invalid_cell_attempt" },
        { status: 400 },
      );
    }
    const cellAttempt = parsedAttempt.data;
    if (ctx.apiKeyId === null) {
      return NextResponse.json({ error: "no_run_key" }, { status: 403 });
    }
    if (!threadChat.organizationId) {
      return NextResponse.json({ error: "org_required" }, { status: 403 });
    }
    return cellPoll({
      userId: ctx.userId,
      apiKeyId: ctx.apiKeyId,
      organizationId: threadChat.organizationId,
      threadId,
      threadChatId,
      attempt: cellAttempt,
      status: threadChat.status,
      terminal,
    });
  }

  // Revoke-on-terminal-READ (ADR-003 F3, S12 fix): revoke THIS token only AFTER we
  // have served terminal=true to it — so the worker is GUARANTEED to observe
  // terminal=true at least once before the token dies. Revoking at thread-finish
  // instead (the old path) let the background revoke beat the worker's next poll, so
  // the worker only ever saw a 401 and laundered it into a silent COMPLETED. With
  // the revoke moved here, terminal=true is the normal worker signal and a
  // 401/403-without-terminal is genuinely anomalous (the worker backstop keys on
  // that). Dead-worker backstop: the 1-day token expiry (plugin minimum).
  if (terminal && ctx.apiKeyId) {
    const apiKeyId = ctx.apiKeyId;
    const userId = ctx.userId;
    waitUntil(
      revokeDaemonTokenById({ userId, apiKeyId }).catch((error) =>
        console.error("[daemon-token] revoke-on-terminal-read failed", {
          apiKeyId,
          error,
        }),
      ),
    );
  }

  return NextResponse.json({
    status: threadChat.status,
    terminal,
  });
});

/**
 * The cell half of the poll. Not terminal: renew the lease of `attempt`
 * (a fenced attempt renews nothing). Terminal: finish the step, then retire
 * the run's token (never delete it: report deletes it later).
 */
async function cellPoll({
  userId,
  apiKeyId,
  organizationId,
  threadId,
  threadChatId,
  attempt,
  status,
  terminal,
}: {
  userId: string;
  apiKeyId: string;
  organizationId: string;
  threadId: string;
  threadChatId: string;
  attempt: number;
  status: string;
  terminal: boolean;
}): Promise<NextResponse> {
  const stepKey = cellStepKey(apiKeyId);
  /** The step's event-only cell tokens (#693). */
  const cellTokens = { userId, threadId, threadChatId, stepKey };
  if (!terminal) {
    let lease: "renewed" | "refused" | "error";
    try {
      lease = (await stampSeen({ db, stepKey, attempt }))
        ? "renewed"
        : "refused";
    } catch (error) {
      // The poll's job is the status. The lease ages, and only minutes of
      // failures reap the cell.
      console.error("[daemon thread-status] stampSeen failed", {
        threadId,
        stepKey,
        attempt,
        error,
      });
      lease = "error";
    }
    return NextResponse.json({ status, terminal, lease });
  }

  let finished: boolean;
  try {
    finished = await finishStep({ db, stepKey, organizationId, threadId });
  } catch (error) {
    // Nothing is retired: the worker retries and finishStep is idempotent.
    console.error("[daemon thread-status] finishStep failed", {
      threadId,
      stepKey,
      attempt,
      error,
    });
    return NextResponse.json({ error: "cell_finish_failed" }, { status: 500 });
  }
  if (!finished) {
    // The key belongs to another org or thread: www can neither mark the step
    // done nor vouch for it. Fail closed: no grace-period credential, a plain
    // revoke, and an alert once per (stepKey, attempt).
    console.error("[daemon thread-status] cell_step_conflict", {
      threadId,
      organizationId,
      stepKey,
      attempt,
    });
    await alertCellStepOnce({
      organizationId,
      stepKey,
      attempt,
      effect: "step-conflict-alert",
      text: `cell step conflict: step ${stepKey}, attempt ${attempt}`,
      logLabel: "daemon thread-status",
    });
    waitUntil(
      Promise.all([
        revokeDaemonTokenById({ userId, apiKeyId }),
        revokeCellEventTokens(cellTokens),
      ]).catch((error) =>
        console.error("[daemon-token] revoke-on-terminal-read failed", {
          apiKeyId,
          error,
        }),
      ),
    );
    return NextResponse.json({ error: "cell_step_conflict" }, { status: 409 });
  }
  // The cell's event-only tokens (#693) die BEFORE the retire: once retired,
  // this token 401s here, so a failed revoke could never be retried.
  try {
    await revokeCellEventTokens(cellTokens);
  } catch (error) {
    console.error("[daemon-token] cell token revoke on terminal read failed", {
      threadId,
      stepKey,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ error: "cell_revoke_failed" }, { status: 500 });
  }
  try {
    await retireDaemonTokenById({ userId, apiKeyId });
  } catch (error) {
    // 500, so the worker retries: finishStep is idempotent and the retire
    // matches no row once it has landed. Ids only in the log.
    console.error("[daemon-token] retire-on-terminal-read failed", {
      threadId,
      stepKey,
      apiKeyId,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ error: "cell_retire_failed" }, { status: 500 });
  }
  return NextResponse.json({ status, terminal, lease: "finished" });
}
