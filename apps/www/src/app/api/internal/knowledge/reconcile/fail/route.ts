import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireReconcileAuth } from "@/server-lib/knowledge/reconcile-auth";
import { postKnowledgeIntentFailedAlert } from "@/server-lib/knowledge/ops-alert";
import { RECONCILE_WORKER_ERROR_CODES } from "@terragon/knowledge/reconcile-wire";
import { failKnowledgeIntent } from "@terragon/shared/model/knowledge-intent";

/**
 * POST /api/internal/knowledge/reconcile/fail
 *
 * The worker reports a failed attempt with a closed-enum code. Backoff and
 * exhaustion are decided by failKnowledgeIntent (D-14). When this call flips
 * the intent to failed (and only then) one structured log line and one ops
 * alert are emitted, carrying org id, repo, code and attempts only (D-15).
 * Authorized by KNOWLEDGE_RECONCILE_SECRET only (see the context route).
 */
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    intentId: z.string().min(1).max(300),
    code: z.enum(RECONCILE_WORKER_ERROR_CODES),
  })
  .strict();

export async function POST(request: Request): Promise<NextResponse> {
  const denied = requireReconcileAuth(request);
  if (denied) return denied;

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(JSON.parse(await request.text()));
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    const outcome = await failKnowledgeIntent({
      db,
      intentId: parsed.intentId,
      code: parsed.code,
      now: new Date(),
      rng: Math.random,
    });
    if (outcome.result === "not_processing") {
      return NextResponse.json({ error: "not_processing" }, { status: 409 });
    }
    if (outcome.becameFailed) {
      console.error("[knowledge-reconcile] intent failed", {
        intentId: parsed.intentId,
        organizationId: outcome.organizationId,
        repoFullName: outcome.repoFullName,
        code: outcome.code,
        attempts: outcome.attempts,
      });
      await postKnowledgeIntentFailedAlert({
        organizationId: outcome.organizationId,
        repoFullName: outcome.repoFullName,
        code: outcome.code,
        attempts: outcome.attempts,
      });
    }
    return NextResponse.json({
      state: outcome.state,
      attempts: outcome.attempts,
      code: outcome.code,
    });
  } catch (error) {
    console.error("[knowledge-reconcile] fail failed", {
      intentId: parsed.intentId,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
