import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { tryAcquireBoxLock, type BoxLock } from "./box-lock";
import { writeSnapshotAtomic } from "./scheduling-maintenance";
import {
  buildKillAllAsAgentInvocation,
  type Invocation,
} from "./spawn-as-user";

/**
 * The uid-scan reaper (#184, #152 Stage B2; ADR-007 I2/I4/I6).
 *
 * WHY A UID-WIDE KILL. The daemon spawns the agent with `detached: true`
 * (`packages/daemon/src/runtime.ts`), i.e. setsid(2): the `bash -lc … |
 * claude` subtree is its own session and process group from birth. The
 * worker's teardown SIGKILLs only the sudo wrapper's group, so the daemon dies
 * before it can run its own child kill and EVERY worker-driven teardown
 * (cancel, timeout, poll error, a SIGKILLed worker) leaves the agent subtree
 * alive under a foreign pgid. No pgid bookkeeping can name those groups; the
 * kernel can: `kill(-1, SIGKILL)` issued AS the agent account reaches every
 * process of that uid and nothing else (kill(2) permission check).
 *
 * INVARIANT. The reaper runs only under the box lock (`box-lock.ts`): the
 * worker's own sudo is the only spawner of agent-uid processes, the admitted
 * run spawns its daemon after the admission scan, and teardown runs inside the
 * lock — so under the lock no agent-uid process belongs to a live run. The
 * only other agent-uid processes are macOS's per-user launchd helpers
 * (`MACOS_PER_USER_HELPERS`), which respawn on demand; they are excluded from
 * the counts symmetrically (scanned AND residual) but not from the kill, since
 * the kernel takes no exclusion list.
 *
 * CONTRACT. Never throws. Every failure returns a result carrying `error` or
 * `failed` and is logged. `agentUser` arrives ONLY as a parameter — this module
 * never reads `process.env` — so a unit test can never reach sudo by accident.
 */

export type ReapPhase = "boot" | "admission" | "teardown";

export interface ProcRow {
  pid: number;
  pgid: number;
  uid: number;
  comm: string;
}

export interface ReapAgentUidOpts {
  agentUser: string;
  phase: ReapPhase;
  threadId?: string;
  /** When given, `<root>/box-budget.json` is written after every scan. */
  runNamespaceRoot?: string;
  log: (line: string) => void;
  /** Default: `ps -A -o pid,pgid,uid,comm` → `parsePsOutput`. */
  listProcesses?: () => Promise<ProcRow[]>;
  /** Default: `id -u <agentUser>`. */
  resolveUid?: (agentUser: string) => Promise<number>;
  /** Default: spawn and AWAIT the exit, bounded by `KILL_EXIT_BOUND_MS`. */
  spawnKill?: (inv: Invocation) => Promise<void>;
  /** Default `process.pid`. */
  selfPid?: number;
  /** Pre-scan settle; default 250 ms for `teardown`, 0 otherwise. */
  settleMs?: number;
  /** How long the post-kill residual poll may run; default 2000 ms. */
  residualBoundMs?: number;
  now?: () => number;
}

export interface ReapAgentUidResult {
  skipped: boolean;
  scanned: number;
  groups: number;
  helpers: number;
  killed: number;
  residual: number;
  failed: number;
  durationMs: number;
  error?: string;
}

export interface BoxBudgetSnapshot {
  ts: string;
  phase: ReapPhase;
  threadId?: string;
  scanned: number;
  killed: number;
  residual: number;
  failed: number;
  escapeesSinceBoot: number;
}

export type BootUidScanOutcome =
  | "disabled"
  | "skipped-busy"
  | "scanned"
  | "error";

export interface BootUidScanOpts {
  root: string;
  agentUser: string;
  log: (line: string) => void;
  tryAcquire?: typeof tryAcquireBoxLock;
  reap?: typeof reapAgentUidEscapees;
}

export interface BootUidScanResult {
  outcome: BootUidScanOutcome;
  result?: ReapAgentUidResult;
  error?: string;
}

export const BOX_BUDGET_FILENAME = "box-budget.json";

/**
 * macOS per-user launchd helpers that appear under the agent uid outside any
 * run. Matched on `basename(comm)` on every platform (harmless on Linux).
 * Anything else left after the kill is reported as `residual` with a sample
 * so an operator can extend this set.
 */
export const MACOS_PER_USER_HELPERS: ReadonlySet<string> = new Set([
  "distnoted", // /usr/sbin/distnoted (agent)
  "lsd", // /usr/libexec/lsd
  "csnameddatad", // …/csnameddatad.xpc/Contents/MacOS/csnameddatad
  "secd", // /usr/libexec/secd
  "contactsd", // …/Contacts.framework/Support/contactsd
]);

const PS_BIN = "/bin/ps";
const ID_BIN = "/usr/bin/id";
/** How long the sudo kill gets to exit before it is SIGKILLed itself. */
const KILL_EXIT_BOUND_MS = 2000;
const RESIDUAL_POLL_MS = 100;
const DEFAULT_RESIDUAL_BOUND_MS = 2000;
const TEARDOWN_SETTLE_MS = 250;
const RESIDUAL_SAMPLE_SIZE = 5;

const execFileAsync = promisify(execFile);

let escapeesSinceBoot = 0;

export function _resetEscapeesSinceBootForTests(): void {
  escapeesSinceBoot = 0;
}

/**
 * Parse `ps -o pid,pgid,uid,comm` output from either platform: a row is kept
 * when its first three whitespace tokens are integers (pid, pgid, uid); the
 * remainder joined by single spaces is `comm`. Headers, blank lines and
 * malformed rows are dropped.
 */
export function parsePsOutput(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 4) continue;
    const [pid, pgid, uid] = tokens;
    if (!/^\d+$/.test(pid ?? "")) continue;
    if (!/^\d+$/.test(pgid ?? "")) continue;
    if (!/^\d+$/.test(uid ?? "")) continue;
    rows.push({
      pid: Number(pid),
      pgid: Number(pgid),
      uid: Number(uid),
      comm: tokens.slice(3).join(" "),
    });
  }
  return rows;
}

/**
 * The agent-uid rows minus ourselves, pid 1 and kernel-owned groups (pgid ≤
 * 0), split into kill targets and the known per-user helpers.
 */
export function selectAgentRows(
  rows: ProcRow[],
  uid: number,
  selfPid: number,
): { targets: ProcRow[]; helpers: ProcRow[] } {
  const targets: ProcRow[] = [];
  const helpers: ProcRow[] = [];
  for (const row of rows) {
    if (row.uid !== uid) continue;
    if (row.pid === selfPid || row.pid === 1) continue;
    if (row.pgid <= 0) continue;
    if (MACOS_PER_USER_HELPERS.has(path.basename(row.comm))) {
      helpers.push(row);
    } else {
      targets.push(row);
    }
  }
  return { targets, helpers };
}

/** The default enumerator: `ps -A -o pid,pgid,uid,comm` (UNIX-style options). */
export async function listProcessesViaPs(): Promise<ProcRow[]> {
  const { stdout } = await execFileAsync(
    PS_BIN,
    ["-A", "-o", "pid,pgid,uid,comm"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return parsePsOutput(stdout);
}

async function resolveUidViaId(agentUser: string): Promise<number> {
  const { stdout } = await execFileAsync(ID_BIN, ["-u", agentUser]);
  const uid = Number(stdout.trim());
  if (!Number.isInteger(uid) || uid < 0) {
    throw new Error(`id -u ${agentUser} returned ${JSON.stringify(stdout)}`);
  }
  return uid;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The default kill: spawn the sudo invocation and AWAIT its exit so the
 * residual measurement happens after the signal has been delivered — NOT the
 * fire-and-forget of `reclaim.ts`. Bounded: a sudo that has not exited after
 * `KILL_EXIT_BOUND_MS` is SIGKILLed and the reaper continues. A non-zero exit
 * is not a failure (`kill` exits 1 on ESRCH when the set was already empty);
 * only a spawn error rejects.
 */
async function spawnKillAwaitingExit(inv: Invocation): Promise<void> {
  const child = spawn(inv.file, inv.args, {
    stdio: "ignore",
    env: { ...process.env, ...inv.env },
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), KILL_EXIT_BOUND_MS);
  });
  const settled = new Promise<"settled">((resolve) => {
    void (async () => {
      try {
        await exited;
      } catch {
        // surfaced by the `await exited` below
      }
      resolve("settled");
    })();
  });
  try {
    const first = await Promise.race([settled, timeout]);
    if (first === "timeout") child.kill("SIGKILL");
  } finally {
    clearTimeout(timer);
  }
  await exited;
}

function zeroResult(skipped: boolean, durationMs = 0): ReapAgentUidResult {
  return {
    skipped,
    scanned: 0,
    groups: 0,
    helpers: 0,
    killed: 0,
    residual: 0,
    failed: 0,
    durationMs,
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * One scan-kill-measure pass. See the module comment for the invariant that
 * makes the uid-wide kill safe; the caller MUST hold the box lock.
 */
export async function reapAgentUidEscapees(
  opts: ReapAgentUidOpts,
): Promise<ReapAgentUidResult> {
  const {
    agentUser,
    phase,
    threadId,
    runNamespaceRoot,
    log,
    listProcesses = listProcessesViaPs,
    resolveUid = resolveUidViaId,
    spawnKill = spawnKillAwaitingExit,
    selfPid = process.pid,
    settleMs = phase === "teardown" ? TEARDOWN_SETTLE_MS : 0,
    residualBoundMs = DEFAULT_RESIDUAL_BOUND_MS,
    now = Date.now,
  } = opts;

  if (!agentUser) {
    if (phase === "boot") {
      log("box uid-scan disabled: WORKER_AGENT_USER is empty (ADR-007 I4)");
    }
    return zeroResult(true);
  }

  const startedAt = now();
  const base = { phase, threadId: threadId ?? null };
  try {
    let uid: number;
    let rows: ProcRow[];
    try {
      uid = await resolveUid(agentUser);
      if (settleMs > 0) await sleep(settleMs);
      rows = await listProcesses();
    } catch (e) {
      const error = errorMessage(e);
      log(
        `box.escapees_scan_failed ${JSON.stringify({ ...base, stage: "scan", error })}`,
      );
      return { ...zeroResult(false, now() - startedAt), error };
    }

    const selected = selectAgentRows(rows, uid, selfPid);
    const scanned = selected.targets.length;
    const groups = new Set(selected.targets.map((r) => r.pgid)).size;
    const helpers = selected.helpers.length;
    let failed = 0;
    let residual = 0;
    let residualRows: ProcRow[] = [];

    if (scanned > 0) {
      // The helpers are not targets: nothing to reclaim when scanned === 0.
      const inv = buildKillAllAsAgentInvocation({ agentUser });
      if (inv) {
        try {
          await spawnKill(inv);
        } catch (e) {
          failed = 1;
          log(
            `box.escapees_kill_failed ${JSON.stringify({ ...base, uid, error: errorMessage(e) })}`,
          );
        }
      }
      // Residual: SIGKILL delivery to a large tree is not instantaneous, so
      // re-scan until the filtered set is empty or the bound elapses.
      const pollStart = now();
      residualRows = selected.targets;
      for (;;) {
        try {
          residualRows = selectAgentRows(
            await listProcesses(),
            uid,
            selfPid,
          ).targets;
        } catch (e) {
          log(
            `box.escapees_scan_failed ${JSON.stringify({ ...base, stage: "residual", error: errorMessage(e) })}`,
          );
          break;
        }
        if (residualRows.length === 0) break;
        if (now() - pollStart >= residualBoundMs) break;
        await sleep(RESIDUAL_POLL_MS);
      }
      residual = residualRows.length;
    }

    const killed = Math.max(0, scanned - residual);
    escapeesSinceBoot += killed;
    const durationMs = now() - startedAt;
    log(
      `box.escapees_reaped ${JSON.stringify({
        ...base,
        uid,
        scanned,
        groups,
        helpers,
        killed,
        residual,
        failed,
        durationMs,
      })}`,
    );
    if (residual > 0) {
      const sample = residualRows
        .slice(0, RESIDUAL_SAMPLE_SIZE)
        .map((r) => path.basename(r.comm));
      log(
        `box.escapees_residual ${JSON.stringify({ ...base, uid, residual, sample })}`,
      );
    }

    if (runNamespaceRoot) {
      const snapshot: BoxBudgetSnapshot = {
        ts: new Date().toISOString(),
        phase,
        threadId,
        scanned,
        killed,
        residual,
        failed,
        escapeesSinceBoot,
      };
      try {
        writeSnapshotAtomic(runNamespaceRoot, snapshot, BOX_BUDGET_FILENAME);
      } catch (e) {
        log(
          `box.budget_write_failed ${JSON.stringify({ ...base, root: runNamespaceRoot, error: errorMessage(e) })}`,
        );
      }
    }

    return {
      skipped: false,
      scanned,
      groups,
      helpers,
      killed,
      residual,
      failed,
      durationMs,
    };
  } catch (e) {
    // Belt and braces: nothing above should throw, but the contract is
    // "never throws into the run".
    const error = errorMessage(e);
    log(
      `box.escapees_scan_failed ${JSON.stringify({ ...base, stage: "unexpected", error })}`,
    );
    return { ...zeroResult(false, now() - startedAt), error };
  }
}

/**
 * Boot-time scan (#184 Scope 4): a NON-blocking take of the box lock, then one
 * `phase: "boot"` reap, then release. Busy ⇒ a live run owns the box and its
 * own teardown scan reclaims; never queue behind it and never kill without
 * the lock. Fail-open on the scan: a `BoxLockUnavailableError` (or anything
 * else) from the try-lock is logged and boot continues — the helper's
 * existence is asserted fail-closed by the caller before this runs.
 */
export async function bootUidScan(
  opts: BootUidScanOpts,
): Promise<BootUidScanResult> {
  const {
    root,
    agentUser,
    log,
    tryAcquire = tryAcquireBoxLock,
    reap = reapAgentUidEscapees,
  } = opts;

  if (!agentUser) {
    log("box uid-scan disabled: WORKER_AGENT_USER is empty (ADR-007 I4)");
    return { outcome: "disabled" };
  }

  let lock: BoxLock | null;
  try {
    lock = await tryAcquire({ root, holder: "boot uid scan", log });
  } catch (e) {
    // Typically a BoxLockUnavailableError: a helper that vanished after the
    // boot assert, or a spawn failure. Hygiene, not admission — continue.
    const error = errorMessage(e);
    log(`boot uid scan failed: ${error}`);
    return { outcome: "error", error };
  }
  if (lock === null) {
    log("box lock held by a live worker — boot uid scan skipped");
    return { outcome: "skipped-busy" };
  }

  let result: ReapAgentUidResult;
  try {
    result = await reap({
      agentUser,
      phase: "boot",
      runNamespaceRoot: root,
      log,
    });
  } catch (e) {
    // `reap` never throws by contract; this wrapper's own contract is the
    // one `main()` relies on, so an injected/edited reaper that does throw
    // must not crash boot either.
    const error = errorMessage(e);
    log(`boot uid scan failed: ${error}`);
    return { outcome: "error", error };
  } finally {
    try {
      await lock.release();
    } catch (e) {
      log(`boot uid scan: lock release failed: ${errorMessage(e)}`);
    }
  }
  if (result.error !== undefined) {
    return { outcome: "error", result, error: result.error };
  }
  return { outcome: "scanned", result };
}
