import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { parseDaemonRequest } from "@/lib/daemon-route";
import {
  checkThreadGeneration,
  updateThreadChat,
} from "@terragon/shared/model/threads";
import { CREDENTIAL_SOURCES } from "@terragon/shared/model/credential-source";

/**
 * POST /api/daemon/run-credential-source
 *   body: { threadId, threadChatId, source }
 *
 * Record which credential path an agent run actually took (#209 item 1). The
 * execution plane is the only party that knows, so it is the only party that
 * says so; this route just persists the already-decided label.
 *
 * APPEND-ONLY: it appends exactly one message to the thread's existing
 * message stream and touches nothing else — no status transition, no
 * errorMessage, no terminalCause. Reporting must not move the state machine
 * (the reason this is not /api/daemon-event, which would flip a still-booting
 * thread to `working`).
 *
 * GENERATION FENCE (#125 C1): a superseded or stale generation gets 409 — a
 * run that lost the thread can never write into the live run's transcript. A
 * caller with no `x-run-external-id` fails OPEN, as on every fenced route.
 */
const bodySchema = z.object({
  threadId: z.string().min(1),
  threadChatId: z.string().min(1),
  source: z.enum(CREDENTIAL_SOURCES),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const r = await parseDaemonRequest(request, bodySchema);
  if (r instanceof NextResponse) return r;
  const { threadId, threadChatId, source } = r.body;

  const generation = await checkThreadGeneration({
    db,
    threadId,
    runExternalId: request.headers.get("x-run-external-id"),
  });
  if (!generation.ok) {
    if (generation.reason === "not-found") {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    console.log("[run-credential-source] rejected", {
      threadId,
      reason: generation.reason,
      activeRunExternalId: generation.activeRunExternalId,
    });
    return NextResponse.json(
      {
        error: "superseded",
        activeRunExternalId: generation.activeRunExternalId,
      },
      { status: 409 },
    );
  }

  await updateThreadChat({
    db,
    userId: r.ctx.userId,
    organizationId: r.ctx.organizationId,
    threadId,
    threadChatId,
    updates: {
      appendMessages: [
        {
          type: "credential-source",
          source,
          timestamp: new Date().toISOString(),
        },
      ],
    },
  });
  // The enum only — there is nothing else in this payload to log.
  console.log("[run-credential-source] recorded", { threadId, source });
  return NextResponse.json({ recorded: true });
}
