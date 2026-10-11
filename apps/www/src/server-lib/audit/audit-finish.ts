import type { DB } from "@terragon/shared/db";
import type { ThreadSourceMetadata } from "@terragon/shared";
import {
  claimAuditRun,
  finishAuditRun,
  releaseAuditRunClaim,
  type AuditRunRow,
} from "@terragon/shared/model/audit-findings";
import * as breakerModel from "@terragon/shared/model/self-heal-breaker";
import * as outboxModel from "@terragon/shared/model/self-heal-outbox";
import {
  getThreadChat,
  getThreadMinimal,
} from "@terragon/shared/model/threads";
import { isAbandonedTerminalCause } from "@terragon/shared/model/terminal-cause";
import { AUDIT_SECTIONS } from "@terragon/shared/self-heal/audit-rules";
import { redactSecrets } from "@terragon/utils/redact";

import { getPostHogServer } from "@/lib/posthog-server";

import { resolveBotLogin } from "../review/bot-login";
import { isAuditFindingsStamp } from "../review/review-skill";
import { createDbAuditLedger, type RunDecision } from "./audit-ledger";
import type { CheckOutcome } from "./decide-audit-actions";
import {
  executeAuditFindings,
  type AuditExecutionSummary,
} from "./execute-audit-findings";
import { createIssueWriter } from "./issue-writer";
import {
  parseAuditFindings,
  selectAuditTerminalText,
} from "./parse-audit-findings";
import {
  loadSelfHealContext,
  resolveSelfHealEffective,
  type SelfHealEffective,
} from "./resolve-self-heal";
import { createSelfHealOctokit } from "./self-heal-octokit";
import { preflightCapabilities } from "./self-heal-preflight";
import { PRE_MINT_INSTALLATION_KEY, errorText } from "./audit-shared";

/**
 * The audit lane's finish effect (SC1, D2). Runs for a thread stamped
 * `automation-skill` + `audit-findings`, with or without a PR number, under a
 * hard 20 s deadline: lease-claim, parse, resolve every switch, ONE token mint,
 * preflights, a bounded issue listing, then the decide-persist-drain executor.
 * Whatever the deadline cuts off is already durable in the outbox and finishes
 * on the cron. Never throws.
 */

export const AUDIT_HOOK_DEADLINE_MS = 20_000;
/** The hook resolves at most this long after the executor's deadline. */
const HOOK_GRACE_MS = 500;
/** A run released for an unavailable preflight is retried at most this often. */
const MAX_CLAIM_COUNT = 5;
const AUDIT_ID = "security-audit";

type AuditFindingsStamp = Extract<
  ThreadSourceMetadata,
  { type: "automation-skill" }
>;

/**
 * The audit skill stamp of a thread the writer should act on, or null. Null for
 * an unstamped thread and for an ABANDONED run (superseded / reclaimed): it
 * never finished its audit, so recording an outcome for it would be noise.
 */
export function getAuditFindingsStamp(
  thread:
    | {
        sourceMetadata?: ThreadSourceMetadata | null;
        terminalCause?: Parameters<typeof isAbandonedTerminalCause>[0];
      }
    | null
    | undefined,
): AuditFindingsStamp | null {
  const metadata = thread?.sourceMetadata;
  if (!isAuditFindingsStamp(metadata)) return null;
  if (isAbandonedTerminalCause(thread?.terminalCause ?? null)) return null;
  return metadata;
}

/** The hook's stages, in order; each is timed into the run's log line. */
export type AuditHookStage =
  | "claim"
  | "parse"
  | "switches"
  | "mint"
  | "preflight"
  | "issues"
  | "executor";

export type AuditHookOutcome =
  | "applied"
  | "applied_partial"
  | "dry_run"
  | "disabled"
  | "killed"
  | "unparseable"
  | "missing-permission"
  | "preflight_unavailable"
  | "issues_unknown"
  | "error";

function toCheckResults(
  raw: unknown,
): ReadonlyMap<string, CheckOutcome> | null {
  if (!Array.isArray(raw)) return null;
  const map = new Map<string, CheckOutcome>();
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { fingerprint, outcome } = entry as Record<string, unknown>;
    if (
      typeof fingerprint === "string" &&
      (outcome === "pass" || outcome === "fail" || outcome === "error")
    ) {
      map.set(fingerprint, outcome);
    }
  }
  return map;
}

/** off-reasons that mean the operator switched the loop off. */
function offOutcome(effective: SelfHealEffective): AuditHookOutcome {
  switch (effective.reason) {
    case "flag_off":
    case "killed":
      return "killed";
    case "missing_permission":
      return "missing-permission";
    default:
      return "disabled";
  }
}

export async function handleAuditFindingsAtFinish({
  db,
  userId,
  threadId,
  threadChatId,
  deadlineAt,
}: {
  db: DB;
  userId: string;
  threadId: string;
  threadChatId: string;
  deadlineAt?: Date;
}): Promise<void> {
  const deadline = deadlineAt ?? new Date(Date.now() + AUDIT_HOOK_DEADLINE_MS);
  const state: {
    run: AuditRunRow | null;
    organizationId: string | null;
    executorStarted: boolean;
    /** What the deadline close records once the executor has persisted. */
    persisted: {
      mode: "dry-run" | "on";
      complete: boolean;
      parsed: number;
      decisions: RunDecision[];
    } | null;
    closed: boolean;
  } = {
    run: null,
    organizationId: null,
    executorStarted: false,
    persisted: null,
    closed: false,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Where the 20 s go (#282): ms per finished stage, plus the stage in flight.
  const timing: {
    stagesMs: Partial<Record<AuditHookStage, number>>;
    current: { stage: AuditHookStage; startedAt: number } | null;
  } = { stagesMs: {}, current: null };
  const endStage = (): void => {
    const current = timing.current;
    if (!current) return;
    timing.stagesMs[current.stage] =
      (timing.stagesMs[current.stage] ?? 0) + (Date.now() - current.startedAt);
    timing.current = null;
  };
  const startStage = (stage: AuditHookStage): void => {
    endStage();
    timing.current = { stage, startedAt: Date.now() };
  };
  const logRun = (
    repoFullName: string,
    mode: string,
    outcome: AuditHookOutcome,
  ): void => {
    endStage();
    console.log("[self-heal] audit run", {
      repoFullName,
      threadId,
      mode,
      outcome,
      created: 0,
      updated: 0,
      closed: 0,
      pending: 0,
      stagesMs: timing.stagesMs,
    });
  };

  const close = async (
    finish: Parameters<typeof finishAuditRun>[0] extends infer I
      ? Omit<Extract<I, object>, "db" | "organizationId" | "id">
      : never,
  ): Promise<void> => {
    if (state.closed || !state.run || !state.organizationId) return;
    state.closed = true;
    try {
      await finishAuditRun({
        db,
        organizationId: state.organizationId,
        id: state.run.id,
        claimCount: state.run.claimCount,
        ...finish,
      });
    } catch (error) {
      console.error("[audit-findings] could not record the run outcome", {
        threadId,
        error: errorText(error),
      });
    }
  };

  /**
   * Hand the claim back to the sweep. `unpersistedOnly` releases only while
   * the executor has not persisted (#282); returns false when it refused, and
   * the caller still owns the close.
   */
  const release = async ({
    unpersistedOnly = false,
  }: { unpersistedOnly?: boolean } = {}): Promise<boolean> => {
    if (state.closed || !state.run || !state.organizationId) return false;
    state.closed = true;
    let released = false;
    try {
      released = await releaseAuditRunClaim({
        db,
        organizationId: state.organizationId,
        id: state.run.id,
        ...(unpersistedOnly
          ? { claimCount: state.run.claimCount, unpersistedOnly }
          : {}),
      });
    } catch (error) {
      console.error("[audit-findings] could not release the run claim", {
        threadId,
        error: errorText(error),
      });
    }
    if (unpersistedOnly && !released) state.closed = false;
    return released;
  };

  const pipeline = async (): Promise<void> => {
    startStage("claim");
    const thread = await getThreadMinimal({ db, userId, threadId });
    const stamp = getAuditFindingsStamp(thread);
    if (!thread || !stamp) return;

    const organizationId = thread.organizationId ?? null;
    const repoFullName = thread.githubRepoFullName ?? null;
    if (!organizationId || !repoFullName) {
      console.warn("[audit-findings] skipped: thread has no org or repo", {
        threadId,
      });
      return;
    }
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) {
      console.warn("[audit-findings] skipped: malformed repo slug", {
        threadId,
      });
      return;
    }
    state.organizationId = organizationId;

    const run = await claimAuditRun({
      db,
      organizationId,
      repoFullName,
      threadId,
      audit: AUDIT_ID,
    });
    if (!run) {
      console.log("[audit-findings] run already processed", { threadId });
      return;
    }
    state.run = run;

    const deadlineMs = Math.max(deadline.getTime() - Date.now(), 1_000);
    const signal = AbortSignal.timeout(deadlineMs);

    // ---- parse
    startStage("parse");
    const threadChat = await getThreadChat({
      db,
      threadId,
      threadChatId,
      userId,
    });
    const parsed = parseAuditFindings(
      selectAuditTerminalText(threadChat?.messages ?? null),
      { repoFullName },
    );
    if (!parsed.ok) {
      await close({
        status: "failed",
        outcome: "unparseable",
        error: redactSecrets(parsed.reason),
      });
      logRun(repoFullName, "off", "unparseable");
      return;
    }
    const { block, dropped } = parsed;
    const complete =
      block.complete &&
      AUDIT_SECTIONS[block.audit].every((id) =>
        block.sections.some((section) => section.id === id),
      ) &&
      dropped.schema === 0 &&
      dropped.over_cap === 0;

    const callDeps = {
      db,
      now: () => new Date(),
      log: (message: string, fields: Record<string, unknown>) =>
        Object.keys(fields).length === 0
          ? console.log(message)
          : console.log(message, fields),
      sleep: (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms)),
      rand: Math.random,
    };
    const capture = (event: string, properties: Record<string, string>) =>
      getPostHogServer().capture({ distinctId: userId, event, properties });

    // ---- resolve every switch that needs no GitHub call
    startStage("switches");
    const pre = await loadSelfHealContext({
      db,
      organizationId,
      repoFullName,
      installationKey: PRE_MINT_INSTALLATION_KEY,
    });
    const first = resolveSelfHealEffective({
      ...pre,
      flagEnabled: pre.flagEnabled,
      sideEffectsEnabled: pre.sideEffectsEnabled,
      shadow: pre.shadow,
    });
    if (first.mode === "off") {
      await close({
        status: "done",
        mode: "off",
        outcome: offOutcome(first),
        complete,
        counts: { parsed: block.findings.length },
      });
      logRun(repoFullName, "off", offOutcome(first));
      return;
    }

    // ---- ONE token mint, then the capability preflight
    let octokit: Awaited<ReturnType<typeof createSelfHealOctokit>>["octokit"];
    let installationKey: string;
    startStage("mint");
    try {
      const minted = await createSelfHealOctokit({ owner, repo, signal });
      octokit = minted.octokit;
      installationKey = String(minted.installationId);
    } catch (error) {
      console.error("[audit-findings] token mint failed", {
        threadId,
        error: errorText(error),
      });
      await unavailable(run, repoFullName);
      return;
    }

    startStage("preflight");
    const capability = await preflightCapabilities({
      organizationId,
      installationKey,
      owner,
      repo,
      capability: "writer",
      deadlineAt: deadline,
      deps: callDeps,
    });
    if (!capability.ok && "unavailable" in capability) {
      await unavailable(run, repoFullName);
      return;
    }
    const missing = capability.ok ? [] : capability.missing;

    // The preflight just refreshed the permission latch rows: resolve again.
    const ctx = await loadSelfHealContext({
      db,
      organizationId,
      repoFullName,
      installationKey,
    });
    const afterLatch = resolveSelfHealEffective({
      ...ctx,
    });
    // A latch set by THIS preflight is reported as missing permission below,
    // not as an off decision, so dry-run can still produce its decisions.
    if (
      afterLatch.mode === "off" &&
      afterLatch.reason !== "missing_permission"
    ) {
      await close({
        status: "done",
        mode: "off",
        outcome: offOutcome(afterLatch),
        complete,
        counts: { parsed: block.findings.length },
      });
      logRun(repoFullName, "off", offOutcome(afterLatch));
      return;
    }

    let mode: "dry-run" | "on" = "dry-run";
    let effective: SelfHealEffective = afterLatch;
    if (afterLatch.mode === "off") {
      // Latched permission: a dry-run never writes, an "on" run cannot.
      const withoutLatch = resolveSelfHealEffective({
        ...ctx,
        breakers: { ...ctx.breakers, permissionLatched: false },
      });
      effective = withoutLatch;
      if (withoutLatch.mode === "off") {
        await close({
          status: "done",
          mode: "off",
          outcome: offOutcome(withoutLatch),
          complete,
          counts: { parsed: block.findings.length },
        });
        logRun(repoFullName, "off", offOutcome(withoutLatch));
        return;
      }
      if (missing.length === 0) missing.push("issues");
    }

    mode = effective.mode === "on" ? "on" : "dry-run";

    if (missing.length > 0 && mode === "on") {
      console.warn(
        "[audit-findings] the installation lacks issues: write — issues are not filed",
        { repoFullName, threadId, missing },
      );
      await close({
        status: "done",
        mode,
        outcome: "missing-permission",
        complete,
        counts: { parsed: block.findings.length },
      });
      logRun(repoFullName, mode, "missing-permission");
      return;
    }

    // ---- bounded issue listing, then the executor
    startStage("issues");
    const ledger = createDbAuditLedger({
      db,
      organizationId,
      repoFullName,
      runId: run.id,
      claimCount: run.claimCount,
    });
    const writer = createIssueWriter({
      octokit,
      owner,
      repo,
      botLogin: resolveBotLogin(),
      organizationId,
      installationKey,
      deadlineAt: deadline,
      deps: callDeps,
    });
    const ledgerRows = await ledger.list();
    const issues = await writer.readIssueStates(
      ledgerRows
        .map((row) => row.issueNumber)
        .filter((n): n is number => typeof n === "number"),
    );
    const isPrivate = await writer.isPrivateRepo();

    // W1: the deadline may have released the claim while we were reading
    // GitHub. The check and the flag are synchronous with the timeout's
    // executorStarted test, so exactly one of the two wins: a released run is
    // reprocessed by the sweep, never also counted here.
    if (state.closed) {
      console.log("[audit-findings] claim released at the deadline", {
        threadId,
      });
      return;
    }
    state.executorStarted = true;
    startStage("executor");
    const summary: AuditExecutionSummary = await executeAuditFindings({
      deps: {
        db,
        installationKey,
        ledger,
        writer,
        outbox: outboxModel,
        breakers: breakerModel,
        log: callDeps.log,
        capture,
        now: callDeps.now,
        sleep: callDeps.sleep,
        rand: callDeps.rand,
        onPersisted: (decisions) => {
          state.persisted = {
            mode,
            complete,
            parsed: block.findings.length,
            decisions,
          };
        },
      },
      input: {
        organizationId,
        repoFullName,
        runId: run.id,
        audit: block.audit,
        mode,
        block,
        complete,
        checkResults: toCheckResults(run.checkResults),
        issues,
        settings: ctx.resolved.settings,
        // Unknown visibility is treated as public: the safe disclosure default.
        isPublicRepo: isPrivate !== true,
        deadlineAt: deadline,
      },
    });

    endStage();
    const outcome: AuditHookOutcome =
      mode === "dry-run" && summary.outcome === "applied"
        ? "dry_run"
        : summary.outcome;
    await close({
      status: summary.outcome === "error" ? "failed" : "done",
      mode,
      outcome,
      complete,
      counts: {
        parsed: block.findings.length,
        created: summary.created,
        updated: summary.updated,
        closed: summary.closed,
      },
      skipped:
        missing.length > 0
          ? { missing_permission: 1 }
          : { count: summary.skipped },
      decisions: summary.decisions,
    });
    console.log("[self-heal] audit run", {
      repoFullName,
      threadId,
      mode,
      outcome,
      created: summary.created,
      updated: summary.updated,
      closed: summary.closed,
      pending: summary.pending,
      stagesMs: timing.stagesMs,
    });
  };

  const unavailable = async (
    run: AuditRunRow,
    repoFullName: string,
  ): Promise<void> => {
    logRun(repoFullName, "off", "preflight_unavailable");
    if (run.claimCount >= MAX_CLAIM_COUNT) {
      await close({
        status: "failed",
        outcome: "preflight_unavailable",
        error: "preflight unavailable after repeated attempts",
      });
      return;
    }
    await release();
  };

  const onFailure = async (error: unknown): Promise<void> => {
    console.error("[audit-findings] audit run failed", {
      threadId,
      error: errorText(error),
    });
    await close({
      status: "failed",
      outcome: "error",
      error: errorText(error),
    });
  };

  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(
      () => resolve("timeout"),
      Math.max(deadline.getTime() - Date.now(), 0) + HOOK_GRACE_MS,
    );
  });

  const runPipeline = async (): Promise<"done"> => {
    try {
      await pipeline();
    } catch (error) {
      await onFailure(error);
    }
    return "done";
  };

  try {
    const result = await Promise.race([runPipeline(), timeout]);
    if (result === "timeout") {
      const current = timing.current;
      console.warn("[audit-findings] hook deadline", {
        threadId,
        stage: current?.stage ?? null,
        stageMs: current ? Date.now() - current.startedAt : null,
        stagesMs: { ...timing.stagesMs },
      });
      // The executor persists before it drains, so a started executor leaves
      // every decision durable and the cron finishes the effects. The finish
      // rewrites the whole run row: carry the persisted decisions over, or
      // the run would show no check outcome at all. An executor cut off
      // before its persist wrote nothing: hand the run back to the sweep
      // (#282). The release is fenced on the unwritten decisions, so a persist
      // committing at the same moment keeps the run and it is closed below.
      const releasedUnpersisted =
        state.executorStarted &&
        !state.persisted &&
        (await release({ unpersistedOnly: true }));
      if (releasedUnpersisted) {
        console.log("[audit-findings] claim released before the persist", {
          threadId,
        });
      } else if (state.executorStarted) {
        const persisted = state.persisted;
        await close({
          status: "done",
          outcome: "applied_partial",
          error: "hook_deadline",
          ...(persisted
            ? {
                mode: persisted.mode,
                complete: persisted.complete,
                counts: { parsed: persisted.parsed },
                decisions: persisted.decisions,
              }
            : {}),
        });
      } else {
        await release();
      }
    }
  } catch (error) {
    console.error("[audit-findings] finish hook error", {
      threadId,
      error: errorText(error),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
