import type { DB } from "@terragon/shared/db";
import { listDeliveryPrsForSweep } from "@terragon/shared/model/delivery-loop";

import { db as defaultDb } from "@/lib/db";

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
  limit = DELIVERY_SWEEP_LIMIT,
}: {
  db?: DB;
  evaluate?: typeof evaluateDeliveryPr;
  limit?: number;
} = {}): Promise<{ evaluated: number }> {
  const rows = await listDeliveryPrsForSweep(db, limit);
  for (const row of rows) {
    await evaluate({ deliveryPrId: row.id });
  }
  if (rows.length > 0) {
    console.log("[delivery-loop] sweep", { evaluated: rows.length });
  }
  return { evaluated: rows.length };
}
