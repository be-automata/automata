import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import {
  getThreadGeneration,
  markThreadsSuperseded,
} from "@terragon/shared/model/threads";

/**
 * POST /api/daemon/run-terminal
 *   body: { threadId, threadChatId, runExternalId, cause, detail? }
 *
 * The worker's EXPLICIT terminal for a run the engine cancelled under a native
 * supersede policy (#125 C1) — the sibling of the `custom-error` terminal in
 * /api/daemon-event. Same X-Daemon-Token custody + F1/F2 binding as the other
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

/** Typed terminal causes this endpoint accepts (the full taxonomy is C4's). */
export const RUN_TERMINAL_CAUSES = ["superseded"] as const;

const bodySchema = z.object({
  threadId: z.string().min(1),
  threadChatId: z.string().min(1),
  runExternalId: z.string().min(1).max(256),
  cause: z.enum(RUN_TERMINAL_CAUSES),
  detail: z
    .object({
      policy: z.string().max(64).optional(),
      supersededBy: z.string().max(256).optional(),
    })
    .optional(),
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

  const generation = await getThreadGeneration({ db, threadId });
  if (!generation) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }
  if (
    generation.activeRunExternalId !== null &&
    generation.activeRunExternalId !== runExternalId
  ) {
    console.log("[run-terminal] rejected superseded generation", {
      threadId,
      runExternalId,
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

  // `cause` is an enum of one today; the switch is where C4's typed causes
  // plug in without touching the fence above.
  let applied = false;
  switch (cause) {
    case "superseded": {
      applied =
        (await markThreadsSuperseded({ db, threadIds: [threadId] })) > 0;
      break;
    }
  }
  console.log("[run-terminal] terminal write", {
    threadId,
    runExternalId,
    cause,
    policy: detail?.policy,
    applied,
  });
  return NextResponse.json({ applied });
}
