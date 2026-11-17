import { env } from "@terragon/env/apps-www";
import type { DB } from "@terragon/shared/db";
import { revokeAttempt } from "@terragon/shared/model/cell-authority";
import { reconcileExpiredCells } from "@terragon/sandbox/cell-reconcile";
import type { ReconcileResult } from "@terragon/sandbox/cell-reconcile";
import { createOpenSandboxCellProvider } from "@terragon/sandbox/opensandbox-cell";
import type { ICellProvider } from "@terragon/types/cell";

import { cellBrokerHost, opensandboxConfigured } from "./cell-gate";

/**
 * Cell control plane (#634 S4): the provider handle, the revoke-first teardown
 * and the reconciler wiring. www never calls `create`; the worker does (S5).
 */

/** Used only by `create`, which www never calls. */
const GUEST_ENTRYPOINT: readonly string[] = ["sleep", "infinity"];
const SELF_CHECK_ARGV: readonly string[] = ["true"];

/** Logs the message only: field values (ids, tags) stay out of the provider's own lines. */
function prefixedLogger(prefix: string, withFields: boolean) {
  return {
    info: (msg: string, fields?: Record<string, unknown>) =>
      console.log(
        `[${prefix}] ${msg}`,
        ...(withFields && fields ? [fields] : []),
      ),
    warn: (msg: string, fields?: Record<string, unknown>) =>
      console.warn(
        `[${prefix}] ${msg}`,
        ...(withFields && fields ? [fields] : []),
      ),
  };
}

export function cellProvider(): ICellProvider | null {
  if (!opensandboxConfigured()) return null;
  return createOpenSandboxCellProvider(
    {
      baseUrl: env.OPENSANDBOX_URL,
      apiKey: env.OPENSANDBOX_API_KEY,
      image: env.OPENSANDBOX_GUEST_IMAGE,
      entrypoint: GUEST_ENTRYPOINT,
      selfCheck: { argv: SELF_CHECK_ARGV },
    },
    {
      // Never `this`-bound to deps (workerd: "Illegal invocation").
      fetch: (input, init) => fetch(input, init),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
      logger: prefixedLogger("cell", false),
    },
  );
}

/**
 * Contract teardown order (#634): revokeAttempt first (the bearer dies before
 * anything else), then the provider's vault clear, deny-all and delete. A
 * throwing revokeAttempt still tears the cell down, and its error is rethrown
 * after (a teardown error takes precedence).
 */
export async function teardownCell({
  db,
  provider,
  cellId,
  stepKey,
  attempt,
}: {
  db: DB;
  provider: Pick<ICellProvider, "teardown">;
  cellId: string;
  stepKey: string;
  attempt: number;
}): Promise<void> {
  try {
    await revokeAttempt({ db, stepKey, attempt });
  } finally {
    // Teardown always runs; its own error wins, else the revoke error is rethrown.
    await provider.teardown(cellId);
  }
}

export async function runCellReconciler({
  db,
  provider,
  now = Date.now,
}: {
  db: DB;
  provider: Pick<ICellProvider, "listByTags" | "teardown">;
  now?: () => number;
}): Promise<ReconcileResult> {
  return reconcileExpiredCells({
    provider,
    deployment: cellBrokerHost(),
    // false for an unknown step is fine: nothing to revoke
    revoke: async (stepKey, attempt) => {
      await revokeAttempt({ db, stepKey, attempt });
    },
    now,
    logger: prefixedLogger("cell:reconcile", true),
  });
}
