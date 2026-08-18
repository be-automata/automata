import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import {
  getThreadMinimal,
  getThreadChat,
} from "@terragon/shared/model/threads";
import { getAndVerifyCredentials } from "@/agent/credentials";
import { ensureAgent } from "@terragon/agent/utils";
import { ThreadError } from "@/agent/error";

/**
 * POST /api/daemon/agent-credentials   body: { threadId, threadChatId }
 *
 * The remote (Hatchet) execution plane's pull for the AGENT PROVIDER credential
 * — the piece the in-sandbox path gets for free because apps/www writes it into
 * the sandbox itself (packages/sandbox setup.ts).
 *
 * Why this exists: buildRemoteDaemonMessage decides `useCredits` from whether the
 * user HAS their own credential, but nothing on the remote path ever delivered
 * that credential to the box. The daemon then fell through to whatever
 * ANTHROPIC_API_KEY the operator's box carried — so a user with a Claude
 * subscription silently ran on the operator's API key, and a box without a key
 * failed runs that should never have touched it.
 *
 * Same auth contract as /api/daemon/next-message: X-Daemon-Token, F1 (daemon
 * tokenType only), F2 (token is bound to ONE thread + threadChat), plus the
 * owner/org defense-in-depth checks. The agent is derived from the threadChat
 * SERVER-SIDE — the caller does not get to name which agent's credential it
 * wants.
 *
 * H2-class response: the body carries a live provider credential. Never log it.
 * The worker writes it to a per-run HOME at 0600 and wipes it on exit; it is
 * never persisted to the box's own ~/.claude.
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
    console.log(
      "[daemon agent-credentials] forbidden: token↔threadChat mismatch",
      {
        threadId,
        tokenThreadChatId: ctx.threadChatId,
        org: ctx.organizationId,
      },
    );
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // F2 anchor: bind on threadId too (see the next-message route for why the
  // null clause is temporary).
  if (ctx.threadId !== null && ctx.threadId !== threadId) {
    console.log(
      "[daemon agent-credentials] forbidden: token↔thread mismatch",
      {
        requestedThreadId: threadId,
        tokenThreadId: ctx.threadId,
        org: ctx.organizationId,
      },
    );
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Defense in depth: the token's user must own the thread, and its org must match.
  const thread = await getThreadMinimal({ db, userId: ctx.userId, threadId });
  if (!thread) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if ((thread.organizationId ?? null) !== (ctx.organizationId ?? null)) {
    console.log(
      "[daemon agent-credentials] forbidden: token org != thread org",
      {
        threadId,
        tokenOrg: ctx.organizationId,
        threadOrg: thread.organizationId,
      },
    );
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const threadChat = await getThreadChat({
    db,
    threadId,
    threadChatId,
    userId: ctx.userId,
  });
  if (!threadChat?.agent) {
    return new NextResponse(null, { status: 204 });
  }

  try {
    // Org-fenced on the THREAD's org, exactly like the in-sandbox path
    // (agent/sandbox.ts) — the run uses this org's credential or none.
    const credentials = await getAndVerifyCredentials({
      agent: ensureAgent(threadChat.agent),
      model: null,
      userId: ctx.userId,
      organizationId: thread.organizationId,
    });
    // The agent travels with the credential: the worker must build the child env
    // (and so choose the credential file path) BEFORE it pulls next-message, so
    // it cannot learn the agent from there.
    // H2: do NOT log `credentials`.
    return NextResponse.json({
      agent: ensureAgent(threadChat.agent),
      credentials,
    });
  } catch (error) {
    // A missing/invalid credential is not a server fault: the run falls back to
    // built-in credits, which is what the sandbox path does too.
    if (error instanceof ThreadError) {
      console.log("[daemon agent-credentials] no usable credential", {
        threadId,
        org: ctx.organizationId,
        reason: error.type,
      });
      return NextResponse.json({
        agent: ensureAgent(threadChat.agent),
        credentials: { type: "built-in-credits" },
      });
    }
    throw error;
  }
}
