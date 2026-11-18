import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeDaemonThreadRequest } from "@/lib/daemon-thread-auth";
import { withDaemonAuthUnavailable } from "@/lib/daemon-auth-unavailable";
import { getThreadChat } from "@terragon/shared/model/threads";
import { getAndVerifyCredentialsWithSource } from "@/agent/credentials";
import { recordDeliveredCredential } from "@/server-lib/credential-unavailability";
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
export const POST = withDaemonAuthUnavailable(async function POST(
  request: NextRequest,
): Promise<NextResponse> {
  const auth = await authorizeDaemonThreadRequest({
    request,
    strictThreadId: false,
    logLabel: "daemon agent-credentials",
  });
  if (!auth.ok) return auth.response;
  const { ctx, threadId, threadChatId, thread } = auth;

  const threadChat = await getThreadChat({
    db,
    threadId,
    threadChatId,
    userId: ctx.userId,
  });
  if (!threadChat?.agent) {
    return new NextResponse(null, { status: 204 });
  }

  // #442: record which credential row this run gets (NULL = built-in
  // credits), never throwing. Delivery itself is unchanged in C2: a marked
  // row is still delivered; the dispatch gate (C3, #443) stops runs for it.
  const recordDelivered = (credentialId: string | null) =>
    recordDeliveredCredential({
      db,
      userId: ctx.userId,
      threadId,
      threadChatId,
      credentialId,
      logLabel: "daemon agent-credentials",
    });

  try {
    // Org-fenced on the THREAD's org, exactly like the in-sandbox path
    // (agent/sandbox.ts) — the run uses this org's credential or none.
    const { credentials, credentialId } =
      await getAndVerifyCredentialsWithSource({
        agent: ensureAgent(threadChat.agent),
        model: null,
        userId: ctx.userId,
        organizationId: thread.organizationId,
      });
    await recordDelivered(credentialId);
    // The agent travels with the credential: the worker must build the child env
    // (and so choose the credential file path) BEFORE it pulls next-message, so
    // it cannot learn the agent from there.
    // H2: do NOT log `credentials`.
    return NextResponse.json({
      agent: ensureAgent(threadChat.agent),
      credentials,
    });
  } catch (error) {
    // Either way the run ends up on built-in credits (the worker maps the 5xx
    // below to it too), so no credential row is attributed to it.
    await recordDelivered(null);
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
});
