import { NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import type { DaemonTokenContext } from "@/lib/daemon-token-context";
import { getThreadMinimal } from "@terragon/shared/model/threads";

type ThreadMinimal = NonNullable<Awaited<ReturnType<typeof getThreadMinimal>>>;

export type DaemonThreadAuthResult =
  | {
      ok: true;
      ctx: DaemonTokenContext;
      /** The parsed JSON body, for the caller's own fields. Untrusted. */
      body: Record<string, unknown>;
      threadId: string;
      threadChatId: string;
      thread: ThreadMinimal;
    }
  | { ok: false; response: NextResponse };

/**
 * The auth contract of the daemon thread routes (agent-credentials, cell-plan),
 * in one place: X-Daemon-Token, F1 (daemon tokenType only), the body's
 * threadId and threadChatId, F2 (the token is bound to ONE threadChat and
 * thread), then the owner and org defense-in-depth checks.
 *
 * `strictThreadId`: false keeps the temporary permissive clause (a token with a
 * null threadId is accepted: see the next-message route); true requires the
 * token's threadId to be set and equal to the body's.
 */
export async function authorizeDaemonThreadRequest({
  request,
  strictThreadId,
  logLabel,
}: {
  request: NextRequest;
  strictThreadId: boolean;
  /** Prefix of the refusal log lines, e.g. "daemon agent-credentials". */
  logLabel: string;
}): Promise<DaemonThreadAuthResult> {
  const refuse = (error: string, status: number): DaemonThreadAuthResult => ({
    ok: false,
    response: NextResponse.json({ error }, { status }),
  });
  /** A 403 with its log line, ids only (never the token). */
  const forbid = (
    reason: string,
    fields: Record<string, unknown>,
  ): DaemonThreadAuthResult => {
    console.log(`[${logLabel}] forbidden: ${reason}`, fields);
    return refuse("Forbidden", 403);
  };

  const ctx = await getDaemonTokenContext(request);
  if (!ctx) return refuse("Unauthorized", 401);
  // F1: daemon-purpose tokens only.
  if (ctx.tokenType !== "daemon") return refuse("Forbidden", 403);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return refuse("Invalid body", 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return refuse("Invalid body", 400);
  }
  const threadId = typeof body.threadId === "string" ? body.threadId : null;
  const threadChatId =
    typeof body.threadChatId === "string" ? body.threadChatId : null;
  if (!threadId || !threadChatId) {
    return refuse("Missing threadId or threadChatId", 400);
  }

  // F2: the token is bound to ONE threadChat; reject a request for any other.
  if (ctx.threadChatId !== threadChatId) {
    return forbid("token↔threadChat mismatch", {
      threadId,
      tokenThreadChatId: ctx.threadChatId,
      org: ctx.organizationId,
    });
  }
  // F2 anchor: bind on threadId too. The null clause is temporary (non-strict).
  const threadMismatch = strictThreadId
    ? ctx.threadId === null || ctx.threadId !== threadId
    : ctx.threadId !== null && ctx.threadId !== threadId;
  if (threadMismatch) {
    return forbid("token↔thread mismatch", {
      requestedThreadId: threadId,
      tokenThreadId: ctx.threadId,
      org: ctx.organizationId,
    });
  }

  // Defense in depth: the token's user must own the thread, and its org must match.
  const thread = await getThreadMinimal({ db, userId: ctx.userId, threadId });
  if (!thread) return refuse("Forbidden", 403);
  if ((thread.organizationId ?? null) !== (ctx.organizationId ?? null)) {
    return forbid("token org != thread org", {
      threadId,
      tokenOrg: ctx.organizationId,
      threadOrg: thread.organizationId,
    });
  }

  return { ok: true, ctx, body, threadId, threadChatId, thread };
}
