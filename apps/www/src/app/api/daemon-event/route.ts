import { getDaemonTokenContext } from "@/lib/auth-server";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";
import { DaemonEventAPIBody } from "@terragon/daemon/shared";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";

export async function POST(request: Request) {
  const json: DaemonEventAPIBody = await request.json();
  const {
    messages,
    threadId,
    threadChatId = LEGACY_THREAD_CHAT_ID,
    // Old clients don't send the timezone, so we fallback to UTC
    timezone = "UTC",
  } = json;
  const ctx = await getDaemonTokenContext(request);
  if (!ctx) {
    return new Response("Unauthorized", { status: 401 });
  }
  // ADR-003 F1: daemon-purpose tokens only (a general/CLI token cannot ingest
  // daemon events).
  if (ctx.tokenType !== "daemon") {
    return new Response("Forbidden", { status: 403 });
  }
  // ADR-003 F2: the token is bound to one threadChat — it cannot inject events
  // for a different thread in the org. (Legacy tokens with no threadChatId bound
  // are allowed through for back-compat during rollout; new tokens always bind.)
  if (ctx.threadChatId !== null && ctx.threadChatId !== threadChatId) {
    return new Response("Forbidden", { status: 403 });
  }
  // F2 anchor: bind on threadId too (threadChatId is the shared legacy sentinel
  // when enableThreadChatCreation is off, which alone collapses F2 to org-level).
  // Legacy tokens with no threadId bound pass through during rollout.
  // TODO(f2-threadid-unconditional): drop the `ctx.threadId !== null` clause once
  // pre-anchor tokens have cycled (1-day expiry) — see next-message route marker.
  if (ctx.threadId !== null && ctx.threadId !== threadId) {
    return new Response("Forbidden", { status: 403 });
  }
  const userId = ctx.userId;

  // Prefer computing context usage from the last non-result message's usage
  // fields when available. Do not sum across all messages.
  const computedContextUsage = (() => {
    try {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as any;
        if (!m || m.type === "result") continue;
        const usage = m.message?.usage;
        if (!usage) continue;
        if (m.parent_tool_use_id) continue;
        const input = Number(usage.input_tokens ?? 0);
        const output = Number(usage.output_tokens ?? 0);
        const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0);
        const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
        const total = input + output + cacheCreate + cacheRead;
        return Number.isFinite(total) && total > 0 ? total : null;
      }
      return null;
    } catch (_e) {
      return null;
    }
  })();
  const result = await handleDaemonEvent({
    messages,
    threadId,
    threadChatId,
    userId,
    timezone,
    contextUsage: computedContextUsage ?? null,
    // #7 trace join: continue the trace the remote worker forwards on the header.
    traceparent: request.headers.get("traceparent") ?? undefined,
    // #125 C1: the worker stamps its run generation on every call; the
    // in-sandbox daemon sends none (fails open on the stamp arm).
    runExternalId: request.headers.get("x-run-external-id"),
  });

  if (!result.success) {
    return new Response(result.error, { status: result.status || 500 });
  }

  return new Response("OK");
}
