import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getClaudeOauthAccessToken } from "@/agent/msg/claudeCredentials";
import { db } from "@/lib/db";
import { withDaemonAuthUnavailable } from "@/lib/daemon-auth-unavailable";
import { authorizeDaemonThreadRequest } from "@/lib/daemon-thread-auth";
import {
  OPENSANDBOX_RUNC_PROFILE_ID,
  cellBrokerHost,
  cellsEnabledForUser,
} from "@/server-lib/compute/cell-gate";
import { mintBearer, openStep } from "@terragon/shared/model/cell-authority";
import {
  CellPlanError,
  buildCellCreatePlan,
} from "@terragon/shared/model/cell-create-plan";
import {
  CellEgressNotEnforcedError,
  assertCellEgressEnforced,
} from "@terragon/shared/model/cell-egress-guard";
import {
  getCurrentProfileEvidence,
  getExecutionProfile,
  profileRecordForPolicy,
} from "@terragon/shared/model/execution-profiles";
import { getThreadChat } from "@terragon/shared/model/threads";

/**
 * POST /api/daemon/cell-plan   body: { threadId, threadChatId, attempt, worker, epoch }
 *
 * The worker's per-attempt pull for the create plan of an OpenSandbox cell
 * (#634 S4). Nothing is built at dispatch and nothing secret rides in the
 * workflow input: the worker authenticates with the run's daemon token (the
 * same contract as agent-credentials, with a strict threadId binding) and gets
 * a plan whose vault carries the model token and a per-attempt broker bearer.
 *
 * H2-class response: never log the body; no-store. Every non-mutating refusal
 * runs before openStep, so a refused request never creates or advances a
 * cell_step and never fences an earlier attempt.
 */
export const dynamic = "force-dynamic";

/** 2 h: the step lease and the bearer/cell TTL. */
const CELL_STEP_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const NO_STORE = { "Cache-Control": "no-store" } as const;

const bodySchema = z
  .object({
    threadId: z.string().min(1),
    threadChatId: z.string().min(1),
    attempt: z.number().int().min(1).max(1000),
    worker: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    epoch: z.string().regex(/^\d{1,20}$/),
  })
  .strict();

function reply(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export const POST = withDaemonAuthUnavailable(async function POST(
  request: NextRequest,
): Promise<NextResponse> {
  const auth = await authorizeDaemonThreadRequest({
    request,
    strictThreadId: true,
    logLabel: "daemon cell-plan",
  });
  if (!auth.ok) return auth.response;
  const { ctx, threadId, threadChatId, thread } = auth;

  const parsed = bodySchema.safeParse(auth.body);
  if (!parsed.success) return reply({ error: "invalid_body" }, 400);
  const { attempt, worker, epoch } = parsed.data;

  // Gate: the env and the per-user flag. Off means off: 404.
  if (!(await cellsEnabledForUser({ db, userId: ctx.userId }))) {
    return reply({ error: "cells_disabled" }, 404);
  }
  if (ctx.apiKeyId === null) return reply({ error: "no_run_key" }, 403);
  const stepKey = `cell:${ctx.apiKeyId}`;

  /** Logs the outcome code only (never a body or a value) and answers no-store. */
  const refuse = (
    code: string,
    status: number,
    extra: Record<string, unknown> = {},
  ): NextResponse => {
    console.log("[daemon cell-plan]", {
      threadId,
      stepKey,
      attempt,
      outcome: code,
    });
    return reply({ error: code, ...extra }, status);
  };
  const refuseEgress = (error: CellEgressNotEnforcedError): NextResponse =>
    refuse("egress_not_enforced", 409, { reason: error.reason });

  // cell_step.organization_id is a foreign key: an org-less thread cannot run in a cell.
  if (!thread.organizationId) return refuse("org_required", 403);
  const organizationId = thread.organizationId;

  // Independent reads, fetched together; the refusals below keep their order.
  const [threadChat, profileRow, evidence] = await Promise.all([
    getThreadChat({ db, threadId, threadChatId, userId: ctx.userId }),
    getExecutionProfile({ db, id: OPENSANDBOX_RUNC_PROFILE_ID }),
    getCurrentProfileEvidence({ db, profileId: OPENSANDBOX_RUNC_PROFILE_ID }),
  ]);

  // Explicit: a null chat or agent is not "the default agent" here.
  if (threadChat?.agent !== "claudeCode") {
    return refuse("agent_not_supported", 422);
  }

  // A cell never falls back to built-in credits or an API key: OAuth only. A
  // non-ThreadError failure propagates (500).
  const modelToken = await getClaudeOauthAccessToken({
    userId: ctx.userId,
    organizationId,
  });
  if (modelToken === null) return refuse("no_model_credential", 422);

  if (!profileRow) return refuse("unknown_profile", 409);
  const { profile } = profileRecordForPolicy(profileRow, evidence);
  try {
    assertCellEgressEnforced({ profile, now: new Date() });
  } catch (error) {
    if (!(error instanceof CellEgressNotEnforcedError)) throw error;
    return refuseEgress(error);
  }

  const brokerHost = cellBrokerHost();

  // The first mutation: everything above can refuse without touching the step.
  const opened = await openStep({
    db,
    step: {
      stepKey,
      organizationId,
      threadId,
      attempt,
      stepTimeoutMs: CELL_STEP_TIMEOUT_MS,
      effectBudget: null,
      // Cell pushes are S5.
      allowedRef: null,
    },
  });
  if (!opened.ok) return refuse(opened.reason, 409);

  try {
    const plan = await buildCellCreatePlan(
      {
        stepKey,
        attempt,
        ttlMs: CELL_STEP_TIMEOUT_MS,
        egressRefs: [],
        egress: { brokerHost },
        profile,
        tags: { worker, epoch },
        resources: { cpu: 2, memoryMiB: 4096 },
        modelToken,
        runtime: "runc",
      },
      { now: () => new Date(), mintBearer: (a) => mintBearer({ db, ...a }) },
    );
    console.log("[daemon cell-plan]", {
      threadId,
      stepKey,
      attempt,
      outcome: "planned",
    });
    return reply({ plan });
  } catch (error) {
    if (error instanceof CellPlanError) return refuse(error.code, 409);
    if (error instanceof CellEgressNotEnforcedError) {
      return refuseEgress(error);
    }
    throw error;
  }
});
