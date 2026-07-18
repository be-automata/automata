import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { getThreadMinimal } from "@terragon/shared/model/threads";
import { buildRemoteDaemonMessage } from "@/server-lib/remote-daemon-message";

/**
 * POST /api/daemon/next-message   body: { threadId, threadChatId }
 *
 * The remote (Hatchet) execution plane's pull for the DaemonMessage www would
 * otherwise PUSH to an in-sandbox daemon (ADR-003 §2). Authenticated by the same
 * X-Daemon-Token as event ingestion.
 *
 * F5 (ADR-003): POST with the ids in the BODY — threadChatId is the enumeration
 * key and must stay out of URLs / access logs.
 * F1: the token must be daemon-scoped (tokenType 'daemon'); a general user/CLI
 * token is rejected here.
 * F2: the token↔thread binding is enforced on the token's OWN threadChatId — a
 * daemon token minted for thread A cannot pull thread B even in the same org.
 * Also require the token's user to own the thread and its org to match (defense
 * in depth).
 * H2: the response body carries the prompt (repo content + user text) — SENSITIVE.
 * Never log the body; logs record ids/org only.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = await getDaemonTokenContext(request);
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // F1: daemon-purpose tokens only.
  if (ctx.tokenType !== "daemon") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { threadId?: unknown; threadChatId?: unknown };
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

  // F2: the token is bound to ONE threadChat; reject a request for any other.
  if (ctx.threadChatId !== threadChatId) {
    console.log("[daemon next-message] forbidden: token↔threadChat mismatch", {
      threadId,
      requestedThreadChatId: threadChatId,
      tokenThreadChatId: ctx.threadChatId,
      org: ctx.organizationId,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // F2 anchor: bind on threadId too. threadChatId is the shared legacy sentinel
  // when enableThreadChatCreation is off, so the check above alone collapses to
  // org-level; threadId is unique per thread. (Legacy tokens with no threadId
  // bound are allowed through for back-compat during rollout.)
  // TODO(f2-threadid-unconditional): once all pre-anchor tokens have cycled (1-day
  // expiry backstop after 44bfa7d ships), drop the `ctx.threadId !== null` clause so
  // the threadId binding is UNCONDITIONAL (a daemon token with no threadId is then
  // rejected). Same marker in thread-status + daemon-event routes.
  if (ctx.threadId !== null && ctx.threadId !== threadId) {
    console.log("[daemon next-message] forbidden: token↔thread mismatch", {
      requestedThreadId: threadId,
      tokenThreadId: ctx.threadId,
      org: ctx.organizationId,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Defense in depth: the token's user must own the thread, and its org must match.
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
    return new NextResponse(null, { status: 204 });
  }

  // H2: do NOT log `message` — it contains the prompt.
  return NextResponse.json(message);
}
