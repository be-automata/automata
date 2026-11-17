import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  OPENSANDBOX_RUNC_PROFILE_ID,
  cellBrokerHost,
} from "@/server-lib/compute/cell-gate";
import { postOpsAlert } from "@/server-lib/knowledge/ops-alert";
import { reconcileTokenMatches } from "@/server-lib/knowledge/reconcile-auth";
import { env } from "@terragon/env/apps-www";
import {
  ConformanceEvidenceError,
  type ConformanceChecks,
  RUNC_REQUIRED_CHECKS,
  buildConformanceEvidence,
} from "@terragon/sandbox/conformance-evidence";
import { PROFILE_EVIDENCE_TOKEN_HEADER } from "@terragon/shared/model/box-evidence";
import { platformCellEgressBundle } from "@terragon/shared/model/cell-egress";
import {
  getExecutionProfile,
  insertProfileEvidenceRows,
} from "@terragon/shared/model/execution-profiles";

/**
 * POST /api/internal/profile-evidence/opensandbox
 *
 * Ingest for the OpenSandbox runc conformance run (#634 S3 IT, pushed by
 * packages/sandbox/opensandbox-it/push-evidence.sh). Mirrors the box route:
 *
 *  - PROFILE_EVIDENCE_SECRET authorizes this route only; empty refuses all.
 *  - The profile and the egress allowlist are fixed on the server, never read
 *    from the body; the server judges the raw checks (buildConformanceEvidence).
 *  - measured_at decides expires_at, so it must be recent (24 h) and not in the
 *    future (5 min).
 *  - Errors are enum codes; check names and values are never logged or echoed.
 */
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
const PAST_WINDOW_MS = 24 * 60 * 60 * 1000;
const FUTURE_WINDOW_MS = 5 * 60 * 1000;
const NO_STORE = { "Cache-Control": "no-store" } as const;

const checkGroup = z
  .array(
    z
      .object({ name: z.string().regex(/^[a-z0-9_]{1,64}$/), ok: z.boolean() })
      .strict(),
  )
  .max(64);

// The groups come from the profile's required checks, so the two cannot drift.
const checksSchema = z
  .object(
    Object.fromEntries(
      Object.keys(RUNC_REQUIRED_CHECKS).map((group) => [group, checkGroup]),
    ),
  )
  .strict();

const bodySchema = z
  .object({
    measuredAt: z.string().datetime(),
    platformSha: z.string().regex(/^[0-9a-f]{40}$/),
    artifactDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    checks: checksSchema,
  })
  .strict();

function reply(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request): Promise<NextResponse> {
  if (
    !reconcileTokenMatches(
      env.PROFILE_EVIDENCE_SECRET,
      request.headers.get(PROFILE_EVIDENCE_TOKEN_HEADER),
    )
  ) {
    return reply({ error: "Unauthorized" }, 401);
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return reply({ error: "body_too_large" }, 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return reply({ error: "body_too_large" }, 413);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return reply({ error: "invalid_json" }, 400);
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return reply({ error: "invalid_body" }, 400);
  const body = parsed.data;

  const nowMs = Date.now();
  const measuredAt = new Date(body.measuredAt);
  const age = nowMs - measuredAt.getTime();
  if (age > PAST_WINDOW_MS || age < -FUTURE_WINDOW_MS) {
    return reply({ error: "measured_at_out_of_window" }, 422);
  }

  // The hosts a real cell needs: the model host and this deployment's broker.
  const allowlist = platformCellEgressBundle(cellBrokerHost()).allow ?? [];

  let rows;
  try {
    rows = buildConformanceEvidence({
      profileId: OPENSANDBOX_RUNC_PROFILE_ID,
      allowlist: [...allowlist],
      checks: body.checks as unknown as ConformanceChecks,
      measuredAt: measuredAt.getTime() > nowMs ? new Date(nowMs) : measuredAt,
      platformSha: body.platformSha,
      artifactDigest: body.artifactDigest,
      required: RUNC_REQUIRED_CHECKS,
    });
  } catch (error) {
    if (!(error instanceof ConformanceEvidenceError)) throw error;
    const reason = error.code;
    const alert = await postOpsAlert({
      text: `opensandbox conformance report refused, evidence NOT recorded: profile ${OPENSANDBOX_RUNC_PROFILE_ID}, reason ${reason}, platform ${body.platformSha}`,
    });
    console.warn("[profile-evidence] opensandbox report refused", {
      reason,
      alertSent: alert.sent,
    });
    return reply({ recorded: false, reason }, 422);
  }

  if (!(await getExecutionProfile({ db, id: OPENSANDBOX_RUNC_PROFILE_ID }))) {
    return reply({ error: "unknown_profile" }, 409);
  }
  const inserted = await insertProfileEvidenceRows({ db, rows });
  const expiresAt = inserted[0]?.expiresAt.toISOString() ?? null;
  console.log("[profile-evidence] opensandbox evidence recorded", {
    profileId: OPENSANDBOX_RUNC_PROFILE_ID,
    rows: inserted.length,
    expiresAt,
  });
  return reply({ recorded: true, rows: inserted.length, expiresAt });
}
