import type { DB } from "@terragon/shared/db";
import { findOpenDeliveryPrs } from "@terragon/shared/model/delivery-loop";

import { db as defaultDb } from "@/lib/db";

import { loadDeliveryLoopMode } from "./delivery-mode";

/**
 * Whether the delivery loop owns this pull request right now (#509): an open
 * enrolled row whose effective mode is "on". Two webhook paths defer to it.
 * - mirror-intake must not spawn its own "address changes" / "fix CI" task on
 *   a PR whose fix cycles the loop runs: both would push to one branch.
 * - The review automation's excludeBotSenders filter must still review a
 *   fix-cycle push, whose sender is the App, or the loop never gets its
 *   verdict.
 * Shadow and off change nothing about today's behaviour. Cheap for every
 * other PR: a head ref outside automata/task-* returns false with no query.
 * Fails closed to false (today's behaviour) on any error.
 */

const DELIVERY_BRANCH_PREFIX = "automata/task-";

export async function isDeliveryLoopOwned(
  {
    repoFullName,
    headRef,
    prNumber,
  }: {
    repoFullName: string;
    headRef: string | null | undefined;
    prNumber?: number;
  },
  {
    db = defaultDb,
    loadMode = loadDeliveryLoopMode,
  }: { db?: DB; loadMode?: typeof loadDeliveryLoopMode } = {},
): Promise<boolean> {
  if (
    typeof headRef !== "string" ||
    !headRef.startsWith(DELIVERY_BRANCH_PREFIX)
  ) {
    return false;
  }
  try {
    const rows = await findOpenDeliveryPrs(
      db,
      prNumber === undefined
        ? { repoFullName, headRef }
        : { repoFullName, prNumber },
    );
    for (const row of rows) {
      const mode = await loadMode({
        db,
        organizationId: row.organizationId,
        repoFullName: row.repoFullName,
      });
      if (mode === "on") return true;
    }
    return false;
  } catch (error: unknown) {
    console.error("[delivery-loop] ownership lookup failed", {
      repoFullName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
