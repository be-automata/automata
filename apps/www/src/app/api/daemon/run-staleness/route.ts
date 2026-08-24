import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
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
 * daemon, no credits burned reviewing a SHA that is already obsolete. Same
 * X-Daemon-Token custody + F2 binding as the other daemon endpoints.
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
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { threadId, threadChatId, runExternalId } = parsed.data;
  if (ctx.threadChatId !== null && ctx.threadChatId !== threadChatId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (ctx.threadId !== null && ctx.threadId !== threadId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
