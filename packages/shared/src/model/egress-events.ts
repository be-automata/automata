import { DB } from "../db";
import { egressEvents } from "../db/schema";
import { EgressEvent } from "../db/types";
import { and, desc, eq, lt } from "drizzle-orm";

/**
 * Egress audit sink model (#66). Rows arrive batched from the daemon-token-
 * authed `/api/daemon/egress-event` route (worker proxy / Docker sidecar
 * decisions, or a native-firewall plane's single "policy applied" marker).
 * The planes never import this module — they POST; only the control plane
 * (apps/www) touches the table.
 *
 * MULTI-TENANT: the list read is fenced by `organizationId`. The prune is
 * deliberately NOT org-fenced: it is maintenance over all orgs (same shape as
 * `pruneHatchetRuns`).
 */

/**
 * Rows older than this are pruned. Egress events are audit exhaust with no
 * live consumer past incident-response windows; 30 days keeps a generous
 * forensic window while bounding table growth (age is the only growth bound —
 * nothing ever marks rows consumed).
 */
export const EGRESS_EVENTS_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Insert a batch of egress decisions. No-op on an empty batch. */
export async function insertEgressEvents({
  db,
  events,
}: {
  db: DB;
  events: Array<{
    organizationId?: string | null;
    threadId?: string | null;
    runId: string;
    destinationHost: string;
    destinationPort?: number | null;
    action: "allow" | "deny";
    policyLevel?: string | null;
    source?: string | null;
    /**
     * #108: the posture that produced the decision. Absent ⇒ 'enforce', which
     * is what every pre-#108 plane meant.
     */
    mode?: "enforce" | "observe" | null;
  }>;
}): Promise<void> {
  if (events.length === 0) return;
  const rows = events.map((e) => ({
    organizationId: e.organizationId ?? null,
    threadId: e.threadId ?? null,
    runId: e.runId,
    destinationHost: e.destinationHost,
    destinationPort: e.destinationPort ?? null,
    action: e.action,
    policyLevel: e.policyLevel ?? null,
    source: e.source ?? null,
    mode: e.mode ?? "enforce",
  }));
  try {
    await db.insert(egressEvents).values(rows);
  } catch (error) {
    // #108: production schema migration is MANUAL (AGENTS.md) and has no CI
    // step, so www can reach production before `egress_events.mode` exists.
    // Without this fallback that window turns every audit POST into a 500 and
    // we LOSE the decisions — the one outcome an audit trail may not have.
    // 42703 = undefined_column. Retry once without the marker: the rows land,
    // and they read back as `enforce` from the column default once it is added,
    // which is the honest value for a pre-migration www (it cannot yet be
    // running an observe-mode box). Any other error propagates untouched.
    if (!isUndefinedColumn(error)) {
      throw error;
    }
    console.warn(
      "[egress-events] `mode` column missing — inserting without it. " +
        "The production schema push has not run yet; see AGENTS.md (schema " +
        "push must PRECEDE the deploy).",
    );
    await db
      .insert(egressEvents)
      .values(rows.map(({ mode: _mode, ...rest }) => rest));
  }
}

/** Postgres 42703 = undefined_column, however the driver surfaces it. */
function isUndefinedColumn(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "42703";
}

/**
 * List egress events for one org (newest first), optionally narrowed to one
 * run. Org-fenced: one org can never read another's audit rows.
 */
export async function listEgressEvents({
  db,
  organizationId,
  runId,
  limit = 200,
}: {
  db: DB;
  organizationId: string;
  runId?: string;
  limit?: number;
}): Promise<EgressEvent[]> {
  return db
    .select()
    .from(egressEvents)
    .where(
      and(
        eq(egressEvents.organizationId, organizationId),
        runId ? eq(egressEvents.runId, runId) : undefined,
      ),
    )
    .orderBy(desc(egressEvents.createdAt))
    .limit(limit);
}

/**
 * Delete rows older than EGRESS_EVENTS_PRUNE_AFTER_MS. Deliberately NOT
 * org-fenced: it is maintenance over all orgs (same pattern as
 * `pruneHatchetRuns`). Returns the number of rows deleted.
 */
export async function pruneEgressEvents({
  db,
  now = new Date(),
}: {
  db: DB;
  now?: Date;
}): Promise<number> {
  const deleted = await db
    .delete(egressEvents)
    .where(
      lt(
        egressEvents.createdAt,
        new Date(now.getTime() - EGRESS_EVENTS_PRUNE_AFTER_MS),
      ),
    )
    .returning({ id: egressEvents.id });
  return deleted.length;
}
