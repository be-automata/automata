import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { getThreadMinimal } from "@terragon/shared/model/threads";
import { buildRemoteDaemonMessage } from "@/server-lib/remote-daemon-message";

/**
 * GET /api/daemon/next-message?threadId=…&threadChatId=…
 *
 * The remote (Hatchet) execution plane's pull for the DaemonMessage www would
 * otherwise PUSH to an in-sandbox daemon (ADR-003 §2). Authenticated by the same
 * X-Daemon-Token as the event ingestion.
 *
 * H1 (ADR-003): assert the token↔thread binding — a *valid* daemon token for a
 * *different* thread/org is rejected (not just "any valid token"): the token's
 * user must own the thread AND the token's org must equal the thread's org.
 *
 * H2 (ADR-003): the response body carries the prompt (repo content + user text) —
 * it is SENSITIVE. Never log the body; logs record threadChatId/org only, so a
 * future access log can be added without leaking content.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = await getDaemonTokenContext(request);
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const threadId = searchParams.get("threadId");
  const threadChatId = searchParams.get("threadChatId");
  if (!threadId || !threadChatId) {
    return NextResponse.json(
      { error: "Missing threadId or threadChatId" },
      { status: 400 },
    );
  }

  // H1: token↔thread binding. getThreadMinimal fences by userId, so a null result
  // means the token's user does not own this thread. Then require the org to match
  // the token's org too.
  const thread = await getThreadMinimal({ db, userId: ctx.userId, threadId });
  if (!thread) {
    console.log("[daemon next-message] forbidden: token user does not own thread", {
      threadId,
      threadChatId,
      org: ctx.organizationId,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if ((thread.organizationId ?? null) !== (ctx.organizationId ?? null)) {
    console.log("[daemon next-message] forbidden: token org != thread org", {
      threadId,
      threadChatId,
      tokenOrg: ctx.organizationId,
      threadOrg: thread.organizationId,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const message = await buildRemoteDaemonMessage({
    userId: ctx.userId,
    threadId,
    threadChatId,
  });
  if (!message) {
    // Nothing to send yet (no pending user message / empty prompt).
    return new NextResponse(null, { status: 204 });
  }

  // H2: do NOT log `message` — it contains the prompt.
  return NextResponse.json(message);
}
