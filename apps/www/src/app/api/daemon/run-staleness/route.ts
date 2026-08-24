import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { parseDaemonRequest } from "@/lib/daemon-route";
import {
  getHatchetRunByExternalId,
  hasNewerRun,
} from "@terragon/shared/model/hatchet-run";

/**
 * POST /api/daemon/run-staleness   body: { threadId, threadChatId, runExternalId }
 *
 * The queue-mode staleness self-check (#125 C4): the FIRST thing a
 * `complete-run-queue` run does is ask whether a NEWER run was already
 * recorded for its (org, repo, PR). If so it skips itself with a
 * `stale-skipped` terminal BEFORE provisioning anything — no clone, no
 * daemon, no credits burned reviewing a SHA that is already obsolete.
 *
 * Fails OPEN: an untracked run (no hatchet_run row — a non-review dispatch)
 * is never stale.
 */
const bodySchema = z.object({
  threadId: z.string().min(1),
  threadChatId: z.string().min(1),
  runExternalId: z.string().min(1).max(256),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const r = await parseDaemonRequest(request, bodySchema);
  if (r instanceof NextResponse) return r;
  const { threadId, runExternalId } = r.body;

  const run = await getHatchetRunByExternalId({
    db,
    externalId: runExternalId,
  });
  if (!run || run.threadId !== threadId) {
    return NextResponse.json({ stale: false });
  }
  const stale = await hasNewerRun({
    db,
    organizationId: run.organizationId,
    repoFullName: run.repoFullName,
    prNumber: run.prNumber,
    after: run.createdAt,
    excludeExternalId: runExternalId,
  });
  return NextResponse.json({ stale });
}
