import type { DB } from "@terragon/shared/db";
import type { RepoReviewSetting } from "@terragon/shared/db/types";

/**
 * #718: whether dispatch marks a plain task run for a cell. The same checks
 * cell-plan refuses with, cheapest first: the chat's agent (no read at all),
 * the deployment, org and flag (#708), the repo's egress compile (#705), the
 * `opensandbox/runc` evidence, then the user's Claude OAuth credential (it can
 * refresh over the network). A refusal or a failure of any check means "not
 * eligible": the marker never fails a dispatch.
 *
 * Every module is imported inside its check, so dispatch loads none of them
 * for a run that is never a cell, and an import failure fails closed too.
 * Logs carry the code (and the guard's reason) or the error name only.
 */

interface CellCheckRefusal {
  code: string;
  reason?: string;
}

/** `null` passes; a refusal names its code. */
type CellCheck = () => Promise<CellCheckRefusal | null>;

/**
 * The everyday "not for cells" answers, which the dispatch path has never
 * logged: every plain task run outside a cells org, or on another agent, would
 * otherwise print a line. Only the unexpected refusals after them are logged.
 */
const QUIET_REFUSALS: ReadonlySet<string> = new Set([
  "agent_not_supported",
  "cells_disabled",
]);

/** One fail-closed step: a refusal or a throw is false, logged by code only. */
async function passes(failCode: string, check: CellCheck): Promise<boolean> {
  try {
    const refusal = await check();
    if (refusal === null) return true;
    if (QUIET_REFUSALS.has(refusal.code)) return false;
    console.log("[hatchet] cell check refused (run stays on the box)", {
      code: refusal.code,
      ...(refusal.reason !== undefined ? { reason: refusal.reason } : {}),
    });
    return false;
  } catch (error) {
    console.warn("[hatchet] cell check failed (not eligible)", {
      code: failCode,
      error: error instanceof Error ? error.name : "unknown",
    });
    return false;
  }
}

export async function cellEligibilityAtDispatch({
  db,
  userId,
  organizationId,
  repoFullName,
  row,
  agent,
}: {
  db: DB;
  userId: string;
  organizationId: string;
  repoFullName: string;
  row: RepoReviewSetting | undefined;
  /** The chat's agent; null or undefined is not the default agent. */
  agent: string | null | undefined;
}): Promise<boolean> {
  return (
    (await passes("agent_check_failed", async () => {
      const { cellAgentSupported } = await import("./cell-gate");
      return cellAgentSupported(agent) ? null : { code: "agent_not_supported" };
    })) &&
    (await passes("eligibility_lookup_failed", async () => {
      const { cellsEnabledForRun } = await import("./cell-gate");
      return (await cellsEnabledForRun({ db, userId, organizationId }))
        ? null
        : { code: "cells_disabled" };
    })) &&
    (await passes("egress_check_failed", async () => {
      const [{ cellBrokerHost }, { planCellEgressForRepo }] = await Promise.all(
        [
          import("./cell-gate"),
          import("@terragon/shared/model/cell-egress-catalog"),
        ],
      );
      const plan = planCellEgressForRepo({
        repoFullName,
        row,
        brokerHost: cellBrokerHost(),
      });
      return plan.ok ? null : { code: plan.code, reason: plan.reason };
    })) &&
    (await passes("evidence_check_failed", async () => {
      const { cellEvidenceEligibility, readCellEvidenceStatus } = await import(
        "./cell-evidence-status"
      );
      const verdict = cellEvidenceEligibility(
        await readCellEvidenceStatus({ db, now: new Date(), configured: true }),
      );
      return verdict.eligible
        ? null
        : { code: verdict.code, reason: verdict.reason };
    })) &&
    // Only `!== null` is read: the value is a live credential and is never
    // held, logged or put in the input.
    (await passes("credential_lookup_failed", async () => {
      const { getClaudeOauthAccessToken } = await import(
        "@/agent/msg/claudeCredentials"
      );
      return (await getClaudeOauthAccessToken({ userId, organizationId })) !==
        null
        ? null
        : { code: "no_model_credential" };
    }))
  );
}
