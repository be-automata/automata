import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireReconcileAuth } from "@/server-lib/knowledge/reconcile-auth";
import type { ReconcileContextResponse } from "@terragon/knowledge/reconcile-wire";
import {
  getReadOnlyInstallationToken,
  getRepoInstallationId,
} from "@terragon/shared/github-app";
import { getInstallationOrgAndMode } from "@terragon/shared/model/github-installation";
import {
  KnowledgeReconcileTooLargeError,
  loadKnowledgeReconcileContext,
} from "@terragon/shared/model/knowledge-reconcile";

/**
 * POST /api/internal/knowledge/reconcile/context
 *
 * The worker's read path for one claimed reconcile intent. Returns the 13-05
 * context plus a short-lived READ-ONLY installation token (contents read) for
 * that one repository.
 *
 * Secret scope: KNOWLEDGE_RECONCILE_SECRET authorizes only the three routes
 * under /api/internal/knowledge/reconcile/. It is a shared worker credential.
 * Rotation order: set the worker env first (restart via
 * automata-worker-safe-restart), then the www secret; intents in flight during
 * the gap cost one lease-expiry attempt. www cannot see the caller's scheme, so
 * HTTPS is enforced on the worker side (13-08 refuses a non-loopback http://
 * control-plane URL).
 *
 *  - The organization comes from the intent row, never from the body.
 *  - The token is minted per call, never persisted, and never logged; the only
 *    token-related log line carries the intent id and an outcome enum.
 *  - Every response is Cache-Control: no-store. Errors are enum codes only.
 */
export const dynamic = "force-dynamic";

const bodySchema = z.object({ intentId: z.string().min(1).max(300) }).strict();

const NO_STORE = { "Cache-Control": "no-store" } as const;

function reply(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

type TokenOutcome = "minted" | "mint_failed" | "org_mismatch";

function logTokenOutcome(
  intentId: string,
  outcome: TokenOutcome,
  errorName?: string,
): void {
  console.log("[knowledge-reconcile] context token", {
    intentId,
    outcome,
    ...(errorName ? { errorName } : {}),
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const denied = requireReconcileAuth(request);
  if (denied) {
    denied.headers.set("Cache-Control", "no-store");
    return denied;
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(JSON.parse(await request.text()));
  } catch {
    return reply({ error: "Invalid body" }, 400);
  }

  try {
    const context = await loadKnowledgeReconcileContext({
      db,
      intentId: parsed.intentId,
      now: new Date(),
    });
    if (context.status !== "ready") {
      return reply(context satisfies ReconcileContextResponse);
    }

    const { organizationId, repoFullName } = context.intent;
    const noAccess: ReconcileContextResponse = {
      status: "no_access",
      purgedOrganizationIds: context.purgedOrganizationIds,
    };
    const [owner, name] = repoFullName.split("/");
    if (!owner || !name) {
      logTokenOutcome(parsed.intentId, "mint_failed");
      return reply(noAccess);
    }

    try {
      const installationId = await getRepoInstallationId(owner, name);
      if (installationId === null) {
        logTokenOutcome(parsed.intentId, "mint_failed");
        return reply(noAccess);
      }
      const bound = await getInstallationOrgAndMode({ db, installationId });
      if (bound.organizationId !== organizationId) {
        logTokenOutcome(parsed.intentId, "org_mismatch");
        return reply(noAccess);
      }
      const { token } = await getReadOnlyInstallationToken(
        owner,
        name,
        installationId,
      );
      logTokenOutcome(parsed.intentId, "minted");
      return reply({
        ...context,
        installationToken: token,
        // PD-24: 13-17 fills these from loadTicketSnapshots; until then no ticket pin is admitted.
        tickets: [],
        unavailableClaims: [],
      } satisfies ReconcileContextResponse);
    } catch (error) {
      logTokenOutcome(
        parsed.intentId,
        "mint_failed",
        error instanceof Error ? error.name : undefined,
      );
      return reply(noAccess);
    }
  } catch (error) {
    if (error instanceof KnowledgeReconcileTooLargeError) {
      return reply({ error: "too_large" }, 422);
    }
    console.error("[knowledge-reconcile] context failed", {
      intentId: parsed.intentId,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return reply({ error: "Internal error" }, 500);
  }
}
