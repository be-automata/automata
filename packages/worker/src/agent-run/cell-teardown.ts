import type { ICellProvider } from "@terragon/types/cell";

import type { FailedStep, TeardownCallResult } from "./cell-www-client";

/**
 * The cell teardown sequencer (#656 PR-E). It is built here, and not taken from
 * the adapter's `teardown()`, because that returns `void` (it cannot feed
 * `failedSteps`) and because the contract is ours: www's `revoke` FIRST (the
 * broker bearer must be dead before anything local is touched), then the
 * provider's steps one by one (vault, quarantine, delete: 1.2.1 refuses a
 * deny-all while the vault holds a binding), then a readback of the attempt's
 * tags, then the typed abnormal terminal, then www's `report`.
 *
 * R -> T(cellId) -> B -> T(each survivor) -> B -> A -> P, under one deadline,
 * and it never throws. Every www call in it carries ITS OWN signal, never the
 * run's (which may already be aborted by the engine's cancel).
 */

export const CELL_TEARDOWN_DEADLINE_MS = 90_000;
/** The budget P and A still get once the deadline is spent. */
const EXPIRED_GRACE_MS = 5_000;

const FAILED_ORDER: readonly FailedStep[] = [
  "revoke_attempt",
  "vault",
  "quarantine",
  "delete",
  "survivor",
];

export interface CellTeardownDeps {
  revoke: (
    attempt: number,
    signal: AbortSignal,
  ) => Promise<{ result: TeardownCallResult }>;
  report: (
    attempt: number,
    outcome:
      | { outcome: "clean" }
      | { outcome: "incomplete"; failedSteps: FailedStep[] },
    signal: AbortSignal,
  ) => Promise<TeardownCallResult>;
  provider: Pick<
    ICellProvider,
    "revoke" | "quarantine" | "delete" | "listByTags"
  >;
  /** A, injected; a no-op when there is no end to post. */
  postAbnormal: () => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

export interface CellTeardownKey {
  stepKey: string;
  attempt: number;
  deployment: string;
  /** The created cell, or null when `create` never returned one (B still looks). */
  cellId: string | null;
  /** www deleted the token (409 cell_step_conflict): R, A and P would all 401. Local steps only. */
  skipWww?: boolean;
  /** The provider's vault revoke already ran (the fenced path runs it first). */
  vaultRevoked?: boolean;
}

type Settled<T> = { ok: true; value: T } | { ok: false };

export async function teardownCellRun(
  key: CellTeardownKey,
  deps: CellTeardownDeps,
): Promise<{ failedSteps: FailedStep[] }> {
  const startedAt = deps.now();
  const deadlineAt = startedAt + CELL_TEARDOWN_DEADLINE_MS;
  const failed = new Set<FailedStep>();
  const deadline = new AbortController();
  const expiry = setTimeout(() => deadline.abort(), CELL_TEARDOWN_DEADLINE_MS);
  let expired = false;

  /** Runs `fn` for at most the time left; a hang or a throw is a failed step. */
  async function bounded<T>(
    fn: () => Promise<T>,
    leftMs = deadlineAt - deps.now(),
  ): Promise<Settled<T>> {
    if (leftMs <= 0) {
      expired = true;
      return { ok: false };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), leftMs);
    });
    try {
      const out = await Promise.race([fn(), timeout]);
      if (out === "timeout") {
        expired = true;
        return { ok: false };
      }
      return { ok: true, value: out };
    } catch {
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /** One cell's three provider steps, in the adapter's order; each failure is recorded. */
  async function teardownCell(cellId: string, skipVault: boolean) {
    if (!skipVault) {
      const vault = await bounded(() => deps.provider.revoke(cellId));
      if (!vault.ok) failed.add("vault");
    }
    const quarantine = await bounded(() => deps.provider.quarantine(cellId));
    if (!quarantine.ok) failed.add("quarantine");
    const del = await bounded(() => deps.provider.delete(cellId));
    if (!del.ok) failed.add("delete");
  }

  async function readback(): Promise<string[] | null> {
    const listed = await bounded(() =>
      deps.provider.listByTags({
        automata: "cell",
        stepKey: key.stepKey,
        attempt: String(key.attempt),
        deployment: key.deployment,
      }),
    );
    return listed.ok ? listed.value.map((e) => e.cellId) : null;
  }

  try {
    // R
    if (!key.skipWww) {
      const revoked = await bounded(() =>
        deps.revoke(key.attempt, deadline.signal),
      );
      if (!revoked.ok || revoked.value.result === "failed") {
        failed.add("revoke_attempt");
      }
    }
    // T
    if (key.cellId !== null) {
      await teardownCell(key.cellId, key.vaultRevoked === true);
    }
    // B, then T on each survivor, then B again.
    if (expired || deadlineAt - deps.now() <= 0) {
      failed.add("survivor"); // B skipped: unreadable counts as not clean
    } else {
      const first = await readback();
      if (first === null) {
        failed.add("survivor");
      } else if (first.length > 0) {
        failed.add("survivor");
        for (const id of first) await teardownCell(id, false);
        const last = await readback();
        if (last === null || last.length > 0) failed.add("survivor");
      }
    }
    // A
    if (!key.skipWww) {
      await bounded(
        () => deps.postAbnormal(),
        Math.max(deadlineAt - deps.now(), EXPIRED_GRACE_MS),
      );
    }
    // P
    const failedSteps = FAILED_ORDER.filter((s) => failed.has(s));
    if (!key.skipWww) {
      const signal = expired
        ? AbortSignal.timeout(EXPIRED_GRACE_MS)
        : deadline.signal;
      const body =
        failedSteps.length === 0
          ? ({ outcome: "clean" } as const)
          : ({ outcome: "incomplete", failedSteps } as const);
      const reported = await bounded(
        () => deps.report(key.attempt, body, signal),
        Math.max(deadlineAt - deps.now(), EXPIRED_GRACE_MS),
      );
      if (!reported.ok || reported.value === "failed") {
        deps.log(
          `cell_teardown_incomplete ${JSON.stringify({
            stepKey: key.stepKey,
            attempt: key.attempt,
            steps: failedSteps,
          })}`,
        );
      }
    }
    deps.log(
      `cell.teardown ${JSON.stringify({
        stepKey: key.stepKey,
        attempt: key.attempt,
        failedSteps,
        ms: deps.now() - startedAt,
      })}`,
    );
    return { failedSteps };
  } catch {
    // Unreachable by construction (every step is bounded and caught); the
    // contract is that this never throws.
    const failedSteps = FAILED_ORDER.filter((s) => failed.has(s));
    deps.log(
      `cell.teardown ${JSON.stringify({ stepKey: key.stepKey, attempt: key.attempt, failedSteps, ms: deps.now() - startedAt })}`,
    );
    return { failedSteps };
  } finally {
    clearTimeout(expiry);
  }
}
