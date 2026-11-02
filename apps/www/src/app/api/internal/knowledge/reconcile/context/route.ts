import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireReconcileAuth } from "@/server-lib/knowledge/reconcile-auth";
import { loadTicketSnapshots } from "@/server-lib/knowledge/ticket-snapshots";
import type {
  ReconcileContextResponse,
  TicketSourceCode,
  UnavailableClaim,
  WireSidecar,
  WireTicket,
} from "@terragon/knowledge/reconcile-wire";
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

interface TicketEvidence {
  tickets: WireTicket[];
  unavailableClaims: UnavailableClaim[];
  sidecars: WireSidecar[];
}

/**
 * PD-24: attach ticket snapshots and drop every claim whose ticket cannot be read. Never throws:
 * a tracker failure degrades to source_unavailable for the ticket claims only (the repo claims
 * reconcile normally). Runs after the gate check, so a gated org makes zero tracker calls (D-05).
 */
async function attachTicketEvidence(
  intentId: string,
  context: Extract<
    Awaited<ReturnType<typeof loadKnowledgeReconcileContext>>,
    { status: "ready" }
  >,
): Promise<TicketEvidence> {
  const { ticketClaims, sidecars } = context;
  let tickets: WireTicket[] = [];
  let unavailableClaims: UnavailableClaim[] = [];
  let fetched = 0;
  let cacheHits = 0;
  if (ticketClaims.length > 0) {
    try {
      const result = await loadTicketSnapshots({
        organizationId: context.intent.organizationId,
        repoFullName: context.intent.repoFullName,
        intentId,
        claims: ticketClaims,
      });
      tickets = result.tickets;
      unavailableClaims = result.unavailableClaims;
      fetched = result.fetched;
      cacheHits = result.cacheHits;
    } catch {
      tickets = [];
      unavailableClaims = ticketClaims.map((c) => ({
        claimId: c.claimId,
        code: "source_unavailable" as const,
      }));
    }
  }
  const dropped = new Set(unavailableClaims.map((u) => u.claimId));
  const kept =
    dropped.size === 0
      ? sidecars
      : sidecars
          .map((s) => ({
            ...s,
            claims: s.claims.filter((c) => !dropped.has(c.id)),
          }))
          .filter((s) => s.claims.length > 0);
  const counts: Record<TicketSourceCode, number> = {
    source_unavailable: 0,
    source_too_large: 0,
    pin_unsupported: 0,
  };
  for (const u of unavailableClaims) counts[u.code] += 1;
  console.log("[knowledge-reconcile] ticket evidence", {
    intentId,
    admitted: ticketClaims.length,
    fetched,
    cacheHits,
    ...counts,
  });
  return { tickets, unavailableClaims, sidecars: kept };
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
      const evidence = await attachTicketEvidence(parsed.intentId, context);
      const { ticketClaims: _internal, ...wire } = context;
      return reply({
        ...wire,
        installationToken: token,
        sidecars: evidence.sidecars,
        tickets: evidence.tickets,
        unavailableClaims: evidence.unavailableClaims,
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
