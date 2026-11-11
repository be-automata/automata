import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { postOpsAlert } from "@/server-lib/knowledge/ops-alert";
import { reconcileTokenMatches } from "@/server-lib/knowledge/reconcile-auth";
import { env } from "@terragon/env/apps-www";
import {
  DRIVER_B_PROFILE_ID,
  PROFILE_EVIDENCE_TOKEN_HEADER,
  driverBEvidenceRows,
  driverBMeasuredAtIsCurrent,
  judgeDriverBReport,
} from "@terragon/shared/model/box-evidence";
import {
  getExecutionProfile,
  insertProfileEvidenceRows,
} from "@terragon/shared/model/execution-profiles";

/**
 * POST /api/internal/profile-evidence/box
 *
 * The box's weekly driver B run (packages/worker/deploy/linux/
 * box-evidence-probes.sh) posts the raw output of its two probe containers.
 * This route decides what it proves (box-evidence.ts): a full pass renews the
 * automata-box/observe evidence, anything else records nothing and raises an
 * ops alert, so a box that starts failing its probes is seen days before its
 * evidence expires.
 *
 *  - PROFILE_EVIDENCE_SECRET authorizes this route only; empty refuses all.
 *  - The profile is fixed here, never read from the body.
 *  - measured_at decides expires_at, so a backdated or future-dated report is
 *    refused.
 *  - Errors are enum codes; probe output is never logged or echoed.
 */
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
const NO_STORE = { "Cache-Control": "no-store" } as const;

const bodySchema = z
  .object({
    host: z.string().regex(/^[A-Za-z0-9.-]{1,63}$/),
    measuredAt: z.string().datetime(),
    platformSha: z.string().regex(/^[0-9a-f]{7,40}$/),
    imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    containers: z.array(z.string().max(16 * 1024)).max(4),
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

  const now = new Date();
  const measuredAt = new Date(body.measuredAt);
  if (!driverBMeasuredAtIsCurrent(measuredAt, now)) {
    return reply({ error: "measured_at_out_of_window" }, 422);
  }

  const verdict = judgeDriverBReport(body.containers);
  if (!verdict.ok) {
    const alert = await postOpsAlert({
      text: `box probes failed, evidence NOT renewed: host ${body.host}, profile ${DRIVER_B_PROFILE_ID}, reason ${verdict.reason}, ${verdict.detail}, platform ${body.platformSha}`,
    });
    console.warn("[profile-evidence] driver B report refused", {
      host: body.host,
      reason: verdict.reason,
      alertSent: alert.sent,
    });
    return reply({ recorded: false, reason: verdict.reason });
  }

  if (!(await getExecutionProfile({ db, id: DRIVER_B_PROFILE_ID }))) {
    return reply({ error: "unknown_profile" }, 409);
  }
  const rows = await insertProfileEvidenceRows({
    db,
    rows: driverBEvidenceRows({
      host: body.host,
      measuredAt: measuredAt > now ? now : measuredAt,
      platformSha: body.platformSha,
      imageDigest: body.imageDigest,
    }),
  });
  const expiresAt = rows[0]?.expiresAt.toISOString() ?? null;
  console.log("[profile-evidence] driver B evidence recorded", {
    host: body.host,
    profileId: DRIVER_B_PROFILE_ID,
    rows: rows.length,
    expiresAt,
  });
  return reply({
    recorded: true,
    profileId: DRIVER_B_PROFILE_ID,
    rows: rows.length,
    expiresAt,
  });
}
