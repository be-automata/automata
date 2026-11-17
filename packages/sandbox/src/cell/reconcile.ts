/**
 * Cell reconciler core (#634 S4, AC-7).
 *
 * Reaps cells whose `expiresAt` tag has passed, working only from provider
 * tags (there is no cell table). Pure over injected dependencies: the caller
 * supplies the provider, the control plane's revoke, the clock and a logger.
 */
import type { CellLogger, ICellProvider } from "@terragon/types/cell";

/**
 * Cells reaped per run. Each reap is a few provider requests and the run sits
 * in a Workers cron invocation (a subrequest budget), so the default is small;
 * the rest are `deferred` to the next 10-minute run.
 */
const DEFAULT_RECONCILE_LIMIT = 20;

interface ReconcileExpiredCellsInput {
  provider: Pick<ICellProvider, "listByTags" | "teardown">;
  revoke: (stepKey: string, attempt: number) => Promise<void>;
  now: () => number;
  logger: CellLogger;
  limit?: number;
  /** In [0, 1); injected so tests are deterministic. Default Math.random. */
  random?: () => number;
}

export interface ReconcileResult {
  listed: number;
  expired: number;
  reaped: number;
  failed: number;
  /** Expired cells left for the next run because `limit` was reached. */
  deferred: number;
}

interface CellKey {
  stepKey: string;
  attempt: number;
}

function errorCode(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return typeof code === "string" ? code : e.name;
  }
  return "unknown";
}

/** The step key and attempt the tags name, or null when either is missing or invalid. */
function parseKey(tags: Record<string, string>): CellKey | null {
  const { stepKey, attempt: raw } = tags;
  if (!stepKey || raw === undefined || !/^\d{1,9}$/.test(raw)) return null;
  const attempt = Number(raw);
  return Number.isSafeInteger(attempt) && attempt >= 1
    ? { stepKey, attempt }
    : null;
}

/**
 * Expired when expiresAt is past, or when expiresAt, stepKey or attempt is
 * missing or invalid (fail safe: an unreadable cell is reaped, not kept).
 */
function isExpired(
  tags: Record<string, string>,
  key: CellKey | null,
  nowMs: number,
): boolean {
  const raw = tags.expiresAt;
  if (raw === undefined || !/^\d{1,16}$/.test(raw)) return true;
  if (key === null) return true;
  return Number(raw) <= nowMs;
}

/**
 * A shuffled copy (Fisher-Yates). Expired cells are visited in a random order
 * each run, so cells whose teardown keeps failing cannot hold the same `limit`
 * slots forever and starve the healthy ones behind them.
 */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export async function reconcileExpiredCells(
  input: ReconcileExpiredCellsInput,
): Promise<ReconcileResult> {
  const { provider, revoke, now, logger } = input;
  const limit = input.limit ?? DEFAULT_RECONCILE_LIMIT;
  const entries = await provider.listByTags({});
  const nowMs = now();
  const result: ReconcileResult = {
    listed: entries.length,
    expired: 0,
    reaped: 0,
    failed: 0,
    deferred: 0,
  };

  const expired = entries
    .map((entry) => ({ entry, key: parseKey(entry.tags) }))
    .filter(({ entry, key }) => isExpired(entry.tags, key, nowMs));

  for (const { entry, key } of shuffled(expired, input.random ?? Math.random)) {
    if (result.expired >= limit) {
      result.deferred += 1;
      continue;
    }
    result.expired += 1;

    const cellId = entry.cellId;
    const stepKey = key?.stepKey ?? null;
    const attempt = key?.attempt ?? null;
    let failed = false;

    if (key) {
      try {
        await revoke(key.stepKey, key.attempt);
      } catch (e) {
        // Kill the cell anyway; the revoke failure is counted and logged.
        failed = true;
        logger.warn("cell reconcile revoke failed", {
          cellId,
          stepKey,
          attempt,
          error: errorCode(e),
        });
      }
    } else {
      logger.warn("cell reconcile reaping cell without a valid key", {
        cellId,
      });
    }

    try {
      await provider.teardown(cellId);
      logger.info("cell reconcile reaped", { cellId, stepKey, attempt });
      if (!failed) result.reaped += 1;
    } catch (e) {
      failed = true;
      logger.warn("cell reconcile teardown failed", {
        cellId,
        stepKey,
        attempt,
        error: errorCode(e),
      });
    }
    if (failed) result.failed += 1;
  }
  return result;
}
