import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { parseDaemonRequest } from "@/lib/daemon-route";
import {
  checkThreadGeneration,
  markThreadTerminal,
} from "@terragon/shared/model/threads";
import {
  retireHatchetRun,
  getHatchetRunByExternalId,
} from "@terragon/shared/model/hatchet-run";
import { TERMINAL_CAUSES } from "@terragon/shared/model/terminal-cause";
import { waitUntil } from "@/lib/wait-until";
import { maybeRecheckOnComplete } from "@/server-lib/supersede-recheck";

/**
 * POST /api/daemon/run-terminal
 *   body: { threadId, threadChatId, runExternalId, cause, detail? }
 *
 * The worker's EXPLICIT typed terminal (#125 C1/C4) — `superseded` when the
 * engine cancelled it under a native policy, `stale-skipped` when the queue
 * mode's self-check found a newer run already queued, and the rest of the
 * taxonomy as the worker learns to name them — the sibling of the
 * `custom-error` terminal in /api/daemon-event.
 *
 * GENERATION FENCE: the write is accepted ONLY if `runExternalId` equals the
 * thread's active run (stamped at dispatch by C2). Any other generation gets
 * 409 — a cancelled run that raced a newer dispatch can never rewrite the
 * newer run's thread. A NULL stamp (legacy dispatch) fails OPEN.
 *
 * IDEMPOTENT: the transition targets only reapable (non-terminal) statuses,
 * so a retry after success is a no-op (`applied: false`), never a duplicate.
 */
const bodySchema = z.object({
  threadId: z.string().min(1),
  threadChatId: z.string().min(1),
  runExternalId: z.string().min(1).max(256),
  cause: z.enum(TERMINAL_CAUSES),
  detail: z.object({ policy: z.string().max(64).optional() }).optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const r = await parseDaemonRequest(request, bodySchema);
  if (r instanceof NextResponse) return r;
  const { threadId, runExternalId, cause, detail } = r.body;

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

  // OWNERSHIP: the run row named by the caller-supplied runExternalId must
  // belong to the authenticated thread — a daemon token for thread A must
  // never retire thread B's run. A run with no row (legacy dispatch) only
  // gets the thread terminal.
  const runRow = await getHatchetRunByExternalId({
    db,
    externalId: runExternalId,
  });
  if (runRow && runRow.threadId !== threadId) {
    console.warn("[run-terminal] run/thread mismatch", {
      threadId,
      runExternalId,
      runThreadId: runRow.threadId,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ORDER MATTERS (no transaction spans the two tables): the thread terminal
  // lands first; the run row leaves the supersede-candidate set only once it
  // has, so a failed thread write leaves the row in_flight for the sweep.
  // Both writes are idempotent (reapable-status guard; status column).
  const applied = await markThreadTerminal({ db, threadId, cause });
  if (runRow) {
    await retireHatchetRun({
      db,
      key: { externalId: runExternalId },
      as: cause === "superseded" ? "superseded" : "terminal",
    });
  }
  console.log("[run-terminal] terminal write", {
    threadId,
    runExternalId,
    cause,
    policy: detail?.policy,
    applied,
  });
  // #125 C5: the discard·recheck reconciliation fires off the response path
  // (the dispatch inside can take seconds) and UNCONDITIONALLY — a worker
  // retry of an already-applied terminal must still heal a recheck lost to a
  // crash between the terminal write and the ledger claim (the UNIQUE ledger
  // keeps it at-most-once).
  waitUntil(maybeRecheckOnComplete({ threadId }));
  return NextResponse.json({ applied });
}
