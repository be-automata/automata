import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { verifyCallbackCapability } from "@/server-lib/addon/callback-capability";
import { env } from "@terragon/env/apps-www";
import {
  type AddonDeliveryKind,
  getAddonCall,
  recordAddonDelivery,
} from "@terragon/shared/model/addon-calls";

/**
 * POST /api/addon-callback/<capability>
 *
 * The callback receiver for RAP add-ons (ADR-014 managed tier). An add-on POSTs
 * each result here instead of to the agent's cell, so a result survives the cell's
 * death; a new cell reads it back from `addon_call_delivery`.
 *
 *  - The capability in the path is the only authority (callback-capability.ts).
 *    Forged, expired or disabled (empty secret) → 401.
 *  - The callback must match the capability's call: `id` (tool_result) or
 *    `tool_call_id` (subscription_event) and `group_id` → else 409. The call must
 *    have been recorded before dispatch → else 404. The RAP spec says a runtime
 *    MUST NOT inject unmatched results; a spec-following add-on does not retry 4xx.
 *  - 200 only after the delivery row is written. Any storage failure → 503, so an
 *    add-on that retries 5xx tries again.
 *  - Create-only per (call, delivery key): a retried or replayed delivery answers
 *    200 `duplicate` and is not applied twice. The key is `x-rap-delivery-id` when
 *    the add-on sends one, else a hash of the body.
 *  - Errors are enum codes; the body is never logged or echoed.
 */
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024 * 1024;
const NO_STORE = { "Cache-Control": "no-store" } as const;
const DELIVERY_ID_HEADER = "x-rap-delivery-id";
const DELIVERY_ID = /^[\w.:-]{1,128}$/;

function reply(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ capability: string }> },
): Promise<NextResponse> {
  const { capability } = await params;
  const claims = verifyCallbackCapability(
    env.ADDON_CALLBACK_SECRET,
    capability,
  );
  if (!claims) return reply({ error: "invalid_capability" }, 401);

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return reply({ error: "body_too_large" }, 413);
  }
  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return reply({ error: "invalid_body" }, 400);
    }
    msg = parsed as Record<string, unknown>;
  } catch {
    return reply({ error: "invalid_json" }, 400);
  }

  const type = str(msg.type);
  const kind: AddonDeliveryKind =
    type === "tool_result" || type === "subscription_event" ? type : "other";
  const callIdInBody =
    kind === "subscription_event" ? str(msg.tool_call_id) : str(msg.id);
  const groupMatches = str(msg.group_id) === claims.groupId;
  const callMatches = kind === "other" || callIdInBody === claims.callId;
  if (!groupMatches || !callMatches) {
    return reply({ error: "call_mismatch" }, 409);
  }

  const header = request.headers.get(DELIVERY_ID_HEADER);
  if (header !== null && !DELIVERY_ID.test(header)) {
    return reply({ error: "invalid_delivery_id" }, 400);
  }
  const deliveryKey =
    header ?? `sha256:${createHash("sha256").update(raw).digest("hex")}`;

  try {
    const call = await getAddonCall({
      db,
      callId: claims.callId,
      organizationId: claims.organizationId,
    });
    if (!call || call.groupId !== claims.groupId) {
      return reply({ error: "unknown_call" }, 404);
    }
    const result = await recordAddonDelivery({
      db,
      delivery: {
        callId: claims.callId,
        deliveryKey,
        kind,
        body: msg,
        final: kind === "subscription_event" && msg.final === true,
      },
    });
    return reply({
      ok: true,
      delivery: result === "created" ? "stored" : "duplicate",
    });
  } catch (e: unknown) {
    console.log("[addon-callback] storage unavailable", {
      callId: claims.callId,
      error: e instanceof Error ? e.name : "unknown",
    });
    return reply({ error: "storage_unavailable" }, 503);
  }
}
