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
  }>;
}): Promise<void> {
  if (events.length === 0) return;
  await db.insert(egressEvents).values(
    events.map((e) => ({
      organizationId: e.organizationId ?? null,
      threadId: e.threadId ?? null,
      runId: e.runId,
      destinationHost: e.destinationHost,
      destinationPort: e.destinationPort ?? null,
      action: e.action,
      policyLevel: e.policyLevel ?? null,
      source: e.source ?? null,
    })),
  );
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
