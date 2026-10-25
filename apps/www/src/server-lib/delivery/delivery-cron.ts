import type { DB } from "@terragon/shared/db";
import { listDeliveryPrsForSweep } from "@terragon/shared/model/delivery-loop";

import { db as defaultDb } from "@/lib/db";

import { reconcileStaleDeliveryCycles } from "./cycle-finish";
import { evaluateDeliveryPr } from "./evaluate-delivery-pr";

/** Rows one sweep evaluates, least recently evaluated first. */
export const DELIVERY_SWEEP_LIMIT = 20;

/**
 * The delivery loop's backstop (#509), run on the 10-minute cron tick: a
 * missed webhook, an expired review wait and a finished cycle without a
 * finish event are all picked up here. Rows are evaluated one at a time (the
 * evaluator never throws), so one slow PR cannot starve the others of the
 * cron budget beyond its own GitHub read timeout.
 */
export async function runDeliveryLoopSweep({
  db = defaultDb,
  evaluate = evaluateDeliveryPr,
  reconcile = reconcileStaleDeliveryCycles,
  limit = DELIVERY_SWEEP_LIMIT,
}: {
  db?: DB;
  evaluate?: typeof evaluateDeliveryPr;
  reconcile?: (deps: { db: DB }) => Promise<unknown>;
  limit?: number;
} = {}): Promise<{ evaluated: number }> {
  // Cycles first: a settled or refunded cycle lets its PR move this tick.
  try {
    await reconcile({ db });
  } catch (error: unknown) {
    console.error("[delivery-loop] cycle reconcile failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const rows = await listDeliveryPrsForSweep(db, limit);
  for (const row of rows) {
    await evaluate({ deliveryPrId: row.id });
  }
  if (rows.length > 0) {
    console.log("[delivery-loop] sweep", { evaluated: rows.length });
  }
  return { evaluated: rows.length };
}
