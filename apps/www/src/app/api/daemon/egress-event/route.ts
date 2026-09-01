import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { insertEgressEvents } from "@terragon/shared/model/egress-events";
import { EGRESS_POLICY_LEVELS } from "@terragon/shared/model/egress-policy";

/**
 * POST /api/daemon/egress-event   body: { events: [...] }
 *
 * The egress audit sink (#66, spec §3.3): enforcement planes (worker forward
 * proxy, Docker sidecar — PR B/C) batch their allow/deny decisions here. Same
 * X-Daemon-Token custody + F1 (tokenType='daemon') as the sibling daemon
 * endpoints; the run identity (thread/org/run) comes from the VERIFIED token
 * context, never from the body — a plane can only audit into its own run.
 * `runId` is the token's threadChat binding (the per-run key the token was
 * minted for). Batch is capped: oversize requests are rejected outright
 * (never silently truncated).
 */

/** Hard cap on events per request — a plane batches well below this. */
const MAX_EVENTS_PER_REQUEST = 100;

const eventSchema = z.object({
  destinationHost: z.string().min(1).max(1024),
  destinationPort: z.number().int().min(1).max(65535).optional(),
  action: z.enum(["allow", "deny"]),
  policyLevel: z.enum(EGRESS_POLICY_LEVELS).optional(),
  source: z.enum(["worker", "docker", "e2b", "daytona"]),
  /**
   * #108: the posture that produced the decision. A plane running in OBSERVE
   * mode allows everything, so its `action:"allow"` rows are evidence that
   * traffic happened — never that a policy permitted it. Persisting the marker
   * is what stops the audit trail from overclaiming enforcement. Absent (an
   * older plane) ⇒ 'enforce', which is what those planes meant.
   */
  mode: z.enum(["enforce", "observe"]).optional(),
});

const bodySchema = z.object({
  events: z.array(eventSchema).min(1).max(MAX_EVENTS_PER_REQUEST),
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
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.issues },
      { status: 400 },
    );
  }

  // The token IS the run identity: org + thread + run key all come from the
  // verified context (minted at dispatch), so a plane cannot write another
  // run's audit trail no matter what the body claims.
  const runId = ctx.threadChatId;
  if (!runId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Parsed events pass through as-is: insertEgressEvents owns the single
  // absent→null normalization pass.
  await insertEgressEvents({
    db,
    events: parsed.data.events.map((e) => ({
      ...e,
      organizationId: ctx.organizationId,
      threadId: ctx.threadId,
      runId,
    })),
  });

  return NextResponse.json({ inserted: parsed.data.events.length });
}
