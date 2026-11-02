import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireReconcileAuth } from "@/server-lib/knowledge/reconcile-auth";
import {
  MAX_PUBLISH_BODY_BYTES,
  MAX_PUBLISH_OPS,
  type ReconcilePublishRequest,
} from "@terragon/knowledge/reconcile-wire";
import {
  KnowledgeReconcileInvalidError,
  publishKnowledgeReconcile,
} from "@terragon/shared/model/knowledge-reconcile";

/**
 * POST /api/internal/knowledge/reconcile/publish
 *
 * Publishes the ops of one reconcile, moves the cursor and marks the intent
 * processed in ONE transaction (13-05). Authorized by
 * KNOWLEDGE_RECONCILE_SECRET only (see the context route for its scope and
 * rotation). The organization comes from the intent row; the body is a strict
 * schema, so an organizationId field is refused. A stale claim answers
 * 200 { result: "stale_claim", opsInserted: 0 } (PD-23). Errors are enum codes.
 */
export const dynamic = "force-dynamic";

const SHA40 = /^[0-9a-f]{40}$/;

const opSchema = z
  .object({
    id: z.string().min(1).max(500),
    claimId: z.string().min(1).max(500),
    kind: z.string().min(1).max(50),
    baseVersion: z.number().int().min(1),
    proposal: z.unknown(),
  })
  .strict();

const bodySchema = z
  .object({
    intentId: z.string().min(1).max(300),
    fromSha: z.string().regex(SHA40).nullable(),
    toSha: z.string().regex(SHA40),
    mode: z.enum(["range", "full"]),
    ops: z.array(opSchema).max(MAX_PUBLISH_OPS),
  })
  .strict();

export async function POST(request: Request): Promise<NextResponse> {
  const denied = requireReconcileAuth(request);
  if (denied) return denied;

  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_PUBLISH_BODY_BYTES) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }

  let parsed: ReconcilePublishRequest;
  try {
    parsed = bodySchema.parse(JSON.parse(text)) as ReconcilePublishRequest;
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    const result = await publishKnowledgeReconcile({
      db,
      request: parsed,
      now: new Date(),
    });
    const opsInserted =
      result.result === "stale_claim" ? 0 : result.opsInserted;
    console.log("[knowledge-reconcile] publish", {
      intentId: parsed.intentId,
      result: result.result,
      opsInserted,
    });
    return NextResponse.json({ result: result.result, opsInserted });
  } catch (error) {
    if (error instanceof KnowledgeReconcileInvalidError) {
      return NextResponse.json({ error: "invalid_publish" }, { status: 422 });
    }
    console.error("[knowledge-reconcile] publish failed", {
      intentId: parsed.intentId,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
