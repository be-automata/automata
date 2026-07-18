import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { getThreadChat } from "@terragon/shared/model/threads";
import { isAgentWorking } from "@/agent/thread-status";
import { revokeDaemonTokenById } from "@/lib/daemon-token";
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
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = await getDaemonTokenContext(request);
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
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
}
