import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import {
  checkThreadGeneration,
  markThreadTerminal,
} from "@terragon/shared/model/threads";
import { markHatchetRunSupersededByExternalId } from "@terragon/shared/model/hatchet-run";
import { TERMINAL_CAUSES } from "@terragon/shared/model/terminal-cause";

/**
 * POST /api/daemon/run-terminal
 *   body: { threadId, threadChatId, runExternalId, cause, detail? }
 *
 * The worker's EXPLICIT typed terminal (#125 C1/C4) — `superseded` when the
 * engine cancelled it under a native policy, `stale-skipped` when the queue
 * mode's self-check found a newer run already queued, and the rest of the
 * taxonomy as the worker learns to name them — the sibling of the
 * `custom-error` terminal in /api/daemon-event. Same X-Daemon-Token custody + F1/F2 binding as the other
 * daemon endpoints.
 *
 * GENERATION FENCE: the write is accepted ONLY if `runExternalId` equals the
 * thread's active run (stamped at dispatch by C2). Any other generation gets
 * 409 — a cancelled run that raced a newer dispatch can never rewrite the
 * newer run's thread. A NULL stamp (legacy dispatch) fails OPEN.
 *
 * IDEMPOTENT: the transition targets only reapable (non-terminal) statuses
 * (`markThreadsSuperseded`), so a retry after success is a no-op
 * (`applied: false`), never a duplicate terminal.
 */

const bodySchema = z.object({
  threadId: z.string().min(1),
  threadChatId: z.string().min(1),
  runExternalId: z.string().min(1).max(256),
  // The typed taxonomy (#125 C4) — the worker mirrors it structurally.
  cause: z.enum(TERMINAL_CAUSES),
  detail: z.object({ policy: z.string().max(64).optional() }).optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = await getDaemonTokenContext(request);
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (ctx.tokenType !== "daemon") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.issues },
      { status: 400 },
    );
  }
  const { threadId, threadChatId, runExternalId, cause, detail } = parsed.data;

  // F2: the token is bound to one threadChat (+ threadId anchor).
  if (ctx.threadChatId !== null && ctx.threadChatId !== threadChatId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (ctx.threadId !== null && ctx.threadId !== threadId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const generation = await checkThreadGeneration({
    db,
    threadId,
    runExternalId,
  });
  if (!generation.ok) {
    if (generation.reason === "not-found") {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    // The thread is already terminal-superseded and THIS run is (or may be)
    // its generation: a retried/duplicate terminal from the same run is an
    // idempotent no-op, never a 409 — only a foreign generation is refused.
    if (
      generation.reason === "superseded" &&
      (generation.activeRunExternalId === null ||
        generation.activeRunExternalId === runExternalId)
    ) {
      return NextResponse.json({ applied: false });
    }
    console.log("[run-terminal] rejected", {
      threadId,
      runExternalId,
      reason: generation.reason,
      activeRunExternalId: generation.activeRunExternalId,
      cause,
    });
    return NextResponse.json(
      {
        error: "superseded",
        activeRunExternalId: generation.activeRunExternalId,
      },
      { status: 409 },
    );
  }

  // Both bookkeeping writes are idempotent: the thread transitions only from
  // a reapable status, and the run row flip is an exact-id update.
  const [applied] = await Promise.all([
    markThreadTerminal({ db, threadId, cause }),
    markHatchetRunSupersededByExternalId({ db, externalId: runExternalId }),
  ]);
  console.log("[run-terminal] terminal write", {
    threadId,
    runExternalId,
    cause,
    policy: detail?.policy,
    applied,
  });
  return NextResponse.json({ applied });
}
