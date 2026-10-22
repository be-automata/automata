import { NextRequest, NextResponse } from "next/server";
import type { z } from "zod";
import { getDaemonTokenContext } from "@/lib/auth-server";
import type { DaemonTokenContext } from "@/lib/daemon-token-context";
import {
  DaemonAuthUnavailableError,
  daemonAuthUnavailableResponse,
} from "@/lib/daemon-auth-unavailable";

/**
 * The daemon-facing route preamble, once (ADR-003 F1/F2): X-Daemon-Token →
 * 401 (503 + Retry-After when the auth store is unavailable); a non-daemon
 * token → 403; a body that fails the zod schema → 400; and
 * the F2 binding — the token is bound to one threadChat (+ the threadId
 * anchor, since threadChatId is the shared legacy sentinel when
 * enableThreadChatCreation is off) → 403. Legacy tokens with a null binding
 * pass through during rollout.
 * TODO(f2-threadid-unconditional): drop the `ctx.threadId !== null` clause
 * once pre-anchor tokens have cycled (1-day expiry).
 */
export async function parseDaemonRequest<
  S extends z.ZodType<{ threadId: string; threadChatId: string }>,
>(
  request: NextRequest,
  schema: S,
): Promise<{ ctx: DaemonTokenContext; body: z.infer<S> } | NextResponse> {
  let ctx: DaemonTokenContext | null;
  try {
    ctx = await getDaemonTokenContext(request);
  } catch (error) {
    if (error instanceof DaemonAuthUnavailableError) {
      return daemonAuthUnavailableResponse();
    }
    throw error;
  }
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
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.issues },
      { status: 400 },
    );
  }
  const { threadId, threadChatId } = parsed.data;
  if (ctx.threadChatId !== null && ctx.threadChatId !== threadChatId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (ctx.threadId !== null && ctx.threadId !== threadId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return { ctx, body: parsed.data };
}
