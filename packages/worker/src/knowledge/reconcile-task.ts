import fs from "node:fs/promises";
import path from "node:path";

import {
  assertOpKeyPart,
  MalformedDiffError,
  pageVersionOf,
  parseUnifiedDiff,
  reconcile,
  type Claim,
  type ParsedFileDiff,
  type ReconcileDiff,
  type Sidecar,
  type Updater,
} from "@terragon/knowledge/node";
import {
  MAX_PUBLISH_OPS,
  repoPinTarget,
  repoRelativePath,
  TICKET_KEY,
  ticketPinTarget,
  type KnowledgeReconcileInput,
  type ReconcilePublishOp,
  type ReconcileWorkerErrorCode,
  type UnavailableClaim,
  type WireSidecar,
  type WireTicket,
} from "@terragon/knowledge/reconcile-wire";

import {
  checkCapacity,
  ensureMirror,
  fetchDefaultBranch,
  MirrorError,
  purgeOrgMirrors,
  snapshotPaths,
  sweepSnapshotLeftovers,
  withRepoLock,
  type StatFs,
} from "./mirror";
import { runMirrorGit } from "./hermetic-git";
import {
  MirrorPathError,
  mirrorPaths,
  type MirrorConfig,
  type MirrorPaths,
} from "./mirror-paths";
import type { ReconcileClient } from "./www-client";

export type ReconcileOutcome =
  | "noop"
  | "gated"
  | "published"
  | "superseded"
  | "stale"
  | "failed";

export interface ReconcileResult {
  outcome: ReconcileOutcome;
  code?: ReconcileWorkerErrorCode;
}

export interface ReconcileTaskDeps {
  client: ReconcileClient;
  mirrorConfig: MirrorConfig;
  tenantId: string;
  /** Replaces the review-routing updater (tests count its calls). */
  updater?: Updater;
  statfs?: StatFs;
  now?: () => number;
  log?: (message: string, fields: Record<string, unknown>) => void;
  /** Tests only: a local fixture remote in place of github.com. */
  testHooks?: { remoteUrl?: string; allowFileProtocolForTests?: boolean };
}

/** A failure the task itself diagnoses; carries the wire enum code, never a message. */
class ReconcileTaskError extends Error {
  readonly code: ReconcileWorkerErrorCode;
  constructor(code: ReconcileWorkerErrorCode) {
    super(code);
    this.name = "ReconcileTaskError";
    this.code = code;
  }
}

const SHA40 = /^[0-9a-f]{40}$/;
const SNAPSHOT_SWEEP_MS = 3_600_000;
const DIFF_MAX_BUFFER = 64 * 1024 * 1024;
const BLOB_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * PD-11: reconcile never asks a model in this phase. The engine routes a fact it
 * cannot rewrite to a human when the updater answers nothing, so every coherent
 * drift becomes a review op.
 */
export function reviewRoutingUpdater(): Updater {
  const updater: Updater = {
    calls: 0,
    rework() {
      updater.calls += 1;
      return [];
    },
  };
  return updater;
}

function exitCodeOf(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

function codeOf(error: unknown): ReconcileWorkerErrorCode {
  if (error instanceof ReconcileTaskError) return error.code;
  if (error instanceof MirrorError) return error.code;
  if (error instanceof MirrorPathError) return "control_plane_rejected";
  if (error instanceof MalformedDiffError) return "engine_failed";
  return "worker_error";
}

async function blobAt(
  paths: MirrorPaths,
  sha: string,
  file: string,
): Promise<string | null> {
  try {
    const res = await runMirrorGit(
      paths.bare,
      ["cat-file", "blob", `${sha}:${file}`],
      { scratchHome: paths.tmpDir, maxBuffer: BLOB_MAX_BUFFER },
    );
    return res.stdout;
  } catch {
    return null;
  }
}

async function isAncestor(
  paths: MirrorPaths,
  cursor: string,
  target: string,
): Promise<boolean> {
  try {
    await runMirrorGit(
      paths.bare,
      ["merge-base", "--is-ancestor", cursor, target],
      { scratchHome: paths.tmpDir },
    );
    return true;
  } catch (error) {
    // 1: not an ancestor. 128: the cursor object is gone (a rewrite pruned it).
    const code = exitCodeOf(error);
    if (code === 1 || code === 128) return false;
    throw new MirrorError("fetch_failed", "ancestry check failed");
  }
}

interface RangeDiffs {
  diffs: ReconcileDiff[];
  extraPaths: string[];
}

async function collectRangeDiffs(
  paths: MirrorPaths,
  cursor: string,
  target: string,
  relevant: ReadonlySet<string>,
): Promise<RangeDiffs> {
  const res = await runMirrorGit(
    paths.bare,
    [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "-M",
      "-U0",
      cursor,
      target,
    ],
    { scratchHome: paths.tmpDir, maxBuffer: DIFF_MAX_BUFFER },
  );
  const parsed: ParsedFileDiff[] = parseUnifiedDiff(res.stdout);
  const diffs: ReconcileDiff[] = [];
  const extraPaths: string[] = [];
  for (const file of parsed) {
    const touchesRelevant =
      relevant.has(file.path) ||
      (file.oldPath !== undefined && relevant.has(file.oldPath));
    if (!touchesRelevant) continue;
    const oldFile = file.oldPath ?? file.path;
    const oldText =
      file.status === "added" ? "" : await blobAt(paths, cursor, oldFile);
    const newText =
      file.status === "deleted" ? "" : await blobAt(paths, target, file.path);
    diffs.push({
      path: file.path,
      ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
      hunks: file.hunks,
      oldText: oldText ?? "",
      newText: newText ?? "",
    });
    if (file.status === "renamed") extraPaths.push(file.path);
  }
  return { diffs, extraPaths };
}

interface CheckedContext {
  sidecars: WireSidecar[];
  excluded: number;
}

/**
 * PD-21: the control plane already filters, the worker does not trust it. Every
 * page and every pin target is re-checked before any git or fs call. A path the
 * producer should have excluded rejects the run. A page or claim id the engine
 * cannot key (op ids forbid `: / @ ,` and whitespace) is skipped and counted.
 */
function checkSidecars(sidecars: WireSidecar[]): CheckedContext {
  const kept: WireSidecar[] = [];
  let excluded = 0;
  for (const sidecar of sidecars) {
    if (repoRelativePath(sidecar.page) === null) {
      throw new ReconcileTaskError("control_plane_rejected");
    }
    for (const claim of sidecar.claims) {
      for (const evidence of claim.evidence) {
        // PD-24: repo and ticket pins are checkable; anything else should have been excluded.
        if (
          repoPinTarget(evidence.uri) === null &&
          ticketPinTarget(evidence.uri) === null
        ) {
          throw new ReconcileTaskError("control_plane_rejected");
        }
      }
    }
    try {
      assertOpKeyPart("page", sidecar.page);
      for (const claim of sidecar.claims) assertOpKeyPart("claimId", claim.id);
    } catch {
      excluded += sidecar.claims.length;
      continue;
    }
    kept.push(sidecar);
  }
  return { sidecars: kept, excluded };
}

/**
 * PD-24: the snapshots www shipped. Keys follow the wire shape (they become file names), snapshots
 * are plain objects, keys are unique, and every ticket pin of a sidecar the engine will see has an
 * entry: a missing one must never be read by the engine as "ticket deleted".
 */
function checkTickets(
  tickets: WireTicket[],
  sidecars: WireSidecar[],
): Map<string, WireTicket> {
  const byKey = new Map<string, WireTicket>();
  for (const ticket of tickets) {
    const plain =
      typeof ticket.snapshot === "object" &&
      ticket.snapshot !== null &&
      !Array.isArray(ticket.snapshot);
    if (!TICKET_KEY.test(ticket.key) || !plain || byKey.has(ticket.key)) {
      throw new ReconcileTaskError("control_plane_rejected");
    }
    byKey.set(ticket.key, ticket);
  }
  for (const sidecar of sidecars) {
    for (const claim of sidecar.claims) {
      for (const evidence of claim.evidence) {
        const target = ticketPinTarget(evidence.uri);
        if (target !== null && !byKey.has(target.key)) {
          throw new ReconcileTaskError("control_plane_rejected");
        }
      }
    }
  }
  return byKey;
}

function pinnedTicketKeys(sidecars: WireSidecar[]): Set<string> {
  const out = new Set<string>();
  for (const sidecar of sidecars) {
    for (const claim of sidecar.claims) {
      for (const evidence of claim.evidence) {
        const target = ticketPinTarget(evidence.uri);
        if (target !== null) out.add(target.key);
      }
    }
  }
  return out;
}

function countByCode(claims: UnavailableClaim[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const claim of claims)
    counts[claim.code] = (counts[claim.code] ?? 0) + 1;
  return counts;
}

/** Lays each referenced snapshot at <root>/tickets/<KEY>.json, where the engine reads ticket pins. */
async function writeTicketSnapshots(
  snapshotRoot: string,
  tickets: Map<string, WireTicket>,
  keys: ReadonlySet<string>,
): Promise<void> {
  if (keys.size === 0) return;
  const dir = path.join(snapshotRoot, "tickets");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const key of keys) {
    const ticket = tickets.get(key);
    if (!ticket) throw new ReconcileTaskError("control_plane_rejected");
    const file = path.resolve(dir, `${key}.json`);
    if (!file.startsWith(dir + path.sep)) {
      throw new ReconcileTaskError("control_plane_rejected");
    }
    await fs.writeFile(file, JSON.stringify(ticket.snapshot), {
      mode: 0o600,
      flag: "wx",
    });
  }
}

function pinnedPaths(sidecars: WireSidecar[]): Set<string> {
  const out = new Set<string>();
  for (const sidecar of sidecars) {
    for (const claim of sidecar.claims) {
      for (const evidence of claim.evidence) {
        const target = repoPinTarget(evidence.uri);
        if (target !== null) out.add(target);
      }
    }
  }
  return out;
}

export async function runKnowledgeReconcile(
  input: KnowledgeReconcileInput,
  deps: ReconcileTaskDeps,
): Promise<ReconcileResult> {
  const { client, mirrorConfig } = deps;
  const log =
    deps.log ??
    ((message: string, fields: Record<string, unknown>) =>
      console.error(message, fields));
  const now = deps.now ?? Date.now;
  const intentId = input.intentId;

  const failWith = async (
    code: ReconcileWorkerErrorCode,
  ): Promise<ReconcileResult> => {
    log("[knowledge-reconcile] failed", { intentId, code });
    await client.fail(intentId, code);
    return { outcome: "failed", code };
  };

  // 1. Context.
  const ctx = await client.context(intentId);
  if (ctx.kind === "unreachable") {
    // The control plane cannot record a failure; the lease expiry requeues it.
    log("[knowledge-reconcile] control plane unreachable", { intentId });
    return { outcome: "failed", code: "worker_error" };
  }
  if (ctx.kind === "rejected") return failWith("control_plane_rejected");
  const context = ctx.value;

  // 2. Reap offboarded orgs before any work (PD-4).
  for (const organizationId of context.purgedOrganizationIds) {
    try {
      await purgeOrgMirrors({
        root: mirrorConfig.root,
        tenantId: deps.tenantId,
        organizationId,
      });
    } catch (error) {
      log("[knowledge-reconcile] purge failed", {
        intentId,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  // 3. Idempotency and gates.
  if (context.status !== "ready") {
    if (context.status === "gated") return { outcome: "gated" };
    if (context.status === "no_access") return failWith("repo_access_lost");
    return { outcome: "noop" };
  }

  try {
    // 4. Confused-deputy cross-check, then PD-21 re-checks.
    const { intent } = context;
    if (
      intent.id !== intentId ||
      intent.organizationId !== input.organizationId ||
      intent.targetSha !== input.targetSha ||
      intent.repoFullName.toLowerCase() !== input.repoFullName.toLowerCase()
    ) {
      throw new ReconcileTaskError("control_plane_rejected");
    }
    const checked = checkSidecars(context.sidecars);
    const tickets = checkTickets(context.tickets, checked.sidecars);
    const ticketKeys = pinnedTicketKeys(checked.sidecars);
    log("[knowledge-reconcile] context", {
      intentId,
      excludedClaims: context.excludedClaims + checked.excluded,
      tickets: ticketKeys.size,
      unavailable: countByCode(context.unavailableClaims),
    });
    const target = intent.targetSha;
    const cursor = context.cursor.lastSha;
    if (!SHA40.test(target) || (cursor !== null && !SHA40.test(cursor))) {
      throw new ReconcileTaskError("control_plane_rejected");
    }

    // 5. Mirror work, once, under the per-repo lock.
    const paths = mirrorPaths(
      mirrorConfig.root,
      deps.tenantId,
      intent.organizationId,
      intent.repoFullName,
    );
    await sweepSnapshotLeftovers(paths.tmpDir, {
      olderThanMs: SNAPSHOT_SWEEP_MS,
      now: now(),
    });
    const updater = deps.updater ?? reviewRoutingUpdater();

    const work = await withRepoLock(paths, intentId, async () => {
      await checkCapacity({
        paths,
        config: mirrorConfig,
        statfs: deps.statfs,
      });
      await ensureMirror({
        paths,
        repoFullName: intent.repoFullName,
        defaultBranch: intent.defaultBranch,
        remoteUrl: deps.testHooks?.remoteUrl,
      });
      await fetchDefaultBranch({
        paths,
        config: mirrorConfig,
        defaultBranch: intent.defaultBranch,
        token: context.installationToken,
        statfs: deps.statfs,
        allowFileProtocolForTests: deps.testHooks?.allowFileProtocolForTests,
      });
      try {
        await runMirrorGit(
          paths.bare,
          ["cat-file", "-e", `${target}^{commit}`],
          { scratchHome: paths.tmpDir },
        );
      } catch {
        throw new ReconcileTaskError("non_descendant_unrecoverable");
      }

      const range =
        cursor !== null && (await isAncestor(paths, cursor, target));
      const mode: "range" | "full" = range ? "range" : "full";

      const pins = pinnedPaths(checked.sidecars);
      const relevant = new Set<string>(pins);
      for (const sidecar of checked.sidecars) relevant.add(sidecar.page);
      if (relevant.size === 0) {
        return { mode, ops: [] as ReconcilePublishOp[] };
      }

      let diffs: ReconcileDiff[] | undefined;
      const snapshotSet = new Set<string>(relevant);
      if (range && cursor !== null) {
        const gathered = await collectRangeDiffs(
          paths,
          cursor,
          target,
          relevant,
        );
        diffs = gathered.diffs;
        for (const extra of gathered.extraPaths) snapshotSet.add(extra);
      }

      const snapshot = await snapshotPaths({
        paths,
        config: mirrorConfig,
        target,
        relPaths: [...snapshotSet],
        statfs: deps.statfs,
      });
      try {
        await writeTicketSnapshots(snapshot.root, tickets, ticketKeys);
        const written = new Set(snapshot.written);
        const ops: ReconcilePublishOp[] = [];
        try {
          for (const wire of checked.sidecars) {
            const pageAtTarget = written.has(wire.page)
              ? await fs.readFile(
                  path.join(snapshot.root, "repo", wire.page),
                  "utf8",
                )
              : "";
            // PD-14: the page as of the cursor, so a human edit since then is seen.
            let versionSource = pageAtTarget;
            if (range && cursor !== null) {
              const atCursor = await blobAt(paths, cursor, wire.page);
              if (atCursor !== null) versionSource = atCursor;
            }
            const claims: Claim[] = wire.claims.map((c) => ({
              id: c.id,
              statement: c.statement,
              evidence: c.evidence.map((e) => ({ uri: e.uri, hash: e.hash })),
            }));
            const sidecar: Sidecar = {
              page: wire.page,
              pageVersion: pageVersionOf(versionSource),
              claims,
            };
            const draft = await reconcile(
              snapshot.root,
              pageAtTarget,
              sidecar,
              updater,
              {
                sourceRev: target,
                diffs: range ? diffs : undefined,
                rejected: context.rejected,
              },
            );
            const versions = new Map(
              wire.claims.map((c) => [c.id, c.version] as const),
            );
            for (const op of draft.ops) {
              ops.push({
                id: op.id,
                claimId: op.claimId,
                kind: op.op,
                baseVersion: versions.get(op.claimId) ?? 1,
                proposal: op,
              });
            }
          }
        } catch (error) {
          if (error instanceof ReconcileTaskError) throw error;
          if (error instanceof MirrorError) throw error;
          throw new ReconcileTaskError("engine_failed");
        }
        return { mode, ops };
      } finally {
        await snapshot.cleanup().catch(() => {});
      }
    });

    if (work.ops.length > MAX_PUBLISH_OPS) {
      throw new ReconcileTaskError("engine_failed");
    }

    // 6. Publish once.
    const published = await client.publish({
      intentId,
      fromSha: cursor,
      toSha: target,
      mode: work.mode,
      ops: work.ops,
    });
    if (published.kind === "unreachable") return await failWith("worker_error");
    if (published.kind === "rejected") {
      return await failWith("control_plane_rejected");
    }
    log("[knowledge-reconcile] published", {
      intentId,
      mode: work.mode,
      result: published.value.result,
      ops: work.ops.length,
    });
    switch (published.value.result) {
      case "published":
      case "already_published":
        return { outcome: "published" };
      case "cursor_moved":
        return { outcome: "superseded" };
      case "stale_claim":
        // PD-23: the intent is already back to pending; failing would spend an attempt.
        return { outcome: "stale" };
      case "gated":
        return { outcome: "gated" };
      case "not_processing":
        return { outcome: "noop" };
    }
  } catch (error) {
    const code = codeOf(error);
    log("[knowledge-reconcile] error", {
      intentId,
      code,
      error: error instanceof Error ? error.name : "unknown",
    });
    await client.fail(intentId, code);
    return { outcome: "failed", code };
  }
}
