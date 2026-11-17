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
import { isAgentWorking } from "@/agent/thread-status";
import { taskRunPushBranch } from "@/server-lib/task/remote-task-pr";
import {
  CELL_RUN_TTL_MS,
  cellStepKey,
  isCellLabelValue,
} from "@terragon/types/cell";
import {
  mintBearer,
  openNextAttempt,
} from "@terragon/shared/model/cell-authority";
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
 * POST /api/daemon/cell-plan   body: { threadId, threadChatId, worker, epoch, requestId }
 *
 * The worker's per-attempt pull for the create plan of an OpenSandbox cell
 * (#634 S4). Nothing is built at dispatch and nothing secret rides in the
 * workflow input: the worker authenticates with the run's daemon token (the
 * same contract as agent-credentials, with a strict threadId binding) and gets
 * a plan whose vault carries the model token and a per-attempt broker bearer.
 *
 * The attempt is server-assigned (`openNextAttempt`), idempotent per `requestId`:
 * the worker reuses one id for every HTTP retry of a plan fetch, so a lost
 * response does not burn and fence an attempt. A replay revokes the earlier
 * bearer of that attempt before the new one is minted.
 *
 * H2-class response: never log the body; no-store. Every non-mutating refusal
 * runs before openNextAttempt, so a refused request never creates or advances a
 * cell_step and never fences an earlier attempt.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Pushes spend it (one per generation, never refunded); shared by every attempt of the step. */
const CELL_TASK_EFFECT_BUDGET = 50;

const bodySchema = z
  .object({
    threadId: z.string().min(1),
    threadChatId: z.string().min(1),
    worker: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    epoch: z.string().regex(/^\d{1,20}$/),
    requestId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
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
  const { worker, epoch, requestId } = parsed.data;

  // Gate: the env and the per-user flag. Off means off: 404.
  if (!(await cellsEnabledForUser({ db, userId: ctx.userId }))) {
    return reply({ error: "cells_disabled" }, 404);
  }
  const daemonToken = request.headers.get("X-Daemon-Token");
  if (ctx.apiKeyId === null || daemonToken === null) {
    return reply({ error: "no_run_key" }, 403);
  }
  const stepKey = cellStepKey(ctx.apiKeyId);
  let attempt: number | undefined;

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

  // A future key format that breaks the label rule fails closed here, not at create.
  if (!isCellLabelValue(stepKey)) return refuse("invalid_run_key", 403);

  // cell_step.organization_id is a foreign key: an org-less thread cannot run in a cell.
  if (!thread.organizationId) return refuse("org_required", 403);
  const organizationId = thread.organizationId;

  const brokerHost = cellBrokerHost();
  if (!isCellLabelValue(brokerHost))
    return refuse("invalid_deployment_tag", 409);
  // The zod regex allows a trailing dash, which the cell label rule does not.
  if (!isCellLabelValue(worker)) return refuse("invalid_body", 400);

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
  // A finished run must not get a cell (the worker's poll would end it at once).
  if (!isAgentWorking(threadChat.status)) return refuse("thread_terminal", 409);

  if (!profileRow) return refuse("unknown_profile", 409);
  const { profile } = profileRecordForPolicy(profileRow, evidence);
  try {
    assertCellEgressEnforced({ profile, now: new Date() });
  } catch (error) {
    if (!(error instanceof CellEgressNotEnforcedError)) throw error;
    return refuseEgress(error);
  }

  // The thread row, not startAgentMessage's per-message branch: a mismatch makes
  // the broker refuse the push (fail closed), never widen it.
  const pushBranch = taskRunPushBranch({
    threadId,
    prNumber: thread.githubPRNumber ?? undefined,
    branch: thread.branchName ?? thread.repoBaseBranchName,
    baseBranch: thread.repoBaseBranchName,
  });
  if (pushBranch === null) return refuse("work_branch_unresolved", 409);

  // A cell never falls back to built-in credits or an API key: OAuth only. Null
  // means "no OAuth credential" (422); a failed lookup throws and propagates (5xx).
  const modelToken = await getClaudeOauthAccessToken({
    userId: ctx.userId,
    organizationId,
  });
  if (modelToken === null) return refuse("no_model_credential", 422);

  // The first mutation: everything above can refuse without touching the step.
  const opened = await openNextAttempt({
    db,
    step: {
      stepKey,
      organizationId,
      threadId,
      stepTimeoutMs: CELL_RUN_TTL_MS,
      effectBudget: CELL_TASK_EFFECT_BUDGET,
      allowedRef: `refs/heads/${pushBranch}`,
      nonce: requestId,
    },
  });
  if (!opened.ok) return refuse(opened.reason, 409);
  attempt = opened.attempt;
  try {
    const plan = await buildCellCreatePlan(
      {
        stepKey,
        attempt,
        ttlMs: CELL_RUN_TTL_MS,
        egressRefs: [],
        egress: { brokerHost },
        profile,
        tags: { worker, epoch, deployment: brokerHost },
        resources: { cpu: 2, memoryMiB: 4096 },
        modelToken,
        daemonToken,
        runtime: "runc",
      },
      {
        now: () => new Date(),
        // One live bearer per attempt, atomically: a replay's earlier bearer dies.
        mintBearer: (a) => mintBearer({ db, ...a, replaceOthers: true }),
      },
    );
    console.log("[daemon cell-plan]", {
      threadId,
      stepKey,
      attempt,
      outcome: "planned",
    });
    return reply({ attempt, plan });
  } catch (error) {
    if (error instanceof CellPlanError) return refuse(error.code, 409);
    if (error instanceof CellEgressNotEnforcedError) {
      return refuseEgress(error);
    }
    throw error;
  }
});
