import { and, eq } from "drizzle-orm";
import type { Octokit } from "octokit";

import type { DB } from "@terragon/shared/db";
import { selfHealBreaker } from "@terragon/shared/db/schema";
import type { Automation } from "@terragon/shared/db/types";
import type { PullRequestTriggerConfig } from "@terragon/shared/automations";
import type { AuditFindingRow } from "@terragon/shared/model/audit-findings";
import {
  claimFixAttempt,
  listFixReadyFindings,
} from "@terragon/shared/model/audit-fix-attempts";
import { updateFinding } from "@terragon/shared/model/audit-findings";
import {
  getIssueAutomationsForRepo,
  getPullRequestAutomationsForRepo,
} from "@terragon/shared/model/automations";
import { normalizeRepo } from "@terragon/shared/model/repo-review-settings";
import {
  acquireHalfOpenProbe,
  getBreakerState,
  recordProbeAttempt,
  type BreakerRow,
  type BreakerScopeKind,
} from "@terragon/shared/model/self-heal-breaker";
import { releaseSelfHealSlot } from "@terragon/shared/model/self-heal-slot";
import {
  withSelfHealTx,
  type SelfHealTx,
} from "@terragon/shared/model/self-heal-tx";
import { redactSecrets } from "@terragon/utils/redact";

import { getPostHogServer } from "@/lib/posthog-server";

import { resolveBotLogin } from "../review/bot-login";
import { AUDIT_FIX_SKILL_NAME } from "../review/review-skill";
import {
  logSelfHealDecision,
  type SelfHealDecision,
  type SelfHealWouldDecision,
} from "./decision-log";
import { evaluateFixTrigger } from "./evaluate-fix-trigger";
import { fixBranchName } from "./fix-run-prompt";
import {
  isSelfHealLoopEnabled,
  loadSelfHealContext,
  resolveSelfHealEffective,
} from "./resolve-self-heal";
import { runAuditFixAutomation } from "./run-audit-fix";
import { admitSelfHealRun } from "./self-heal-admission";
import { createSelfHealOctokit } from "./self-heal-octokit";
import { preflightCapabilities } from "./self-heal-preflight";
import { withSelfHealCall, type SelfHealCallDeps } from "./with-self-heal-call";

/**
 * The fix dispatcher (BULK-01): the ONLY start path of a self-heal fix run.
 * Webhooks only mark findings ready; this runs last on the *\/10 self-heal
 * tick. Per tick: flag → up to 20 ready candidates → review-first admission
 * and the box slot → the first candidate that passes evaluateFixTrigger is
 * claimed and dispatched. At most ONE fix run per tick, platform-wide; when
 * nothing is dispatched the slot is released. Never throws.
 *
 * Branch protection is never read here: it is optional hardening, and a
 * free-plan repo without it (or with it unreadable) is dispatched normally.
 *
 * Breakers (BRK-01, RES-15): open or paused_manual refuses. A half-open
 * loop_fix / exec_plane / hatchet_dispatch breaker admits exactly ONE run:
 * its probe is taken in the SAME withSelfHealTx transaction as the claim
 * CAS, so a concurrent claim gets breaker_half_open_probe_taken and a lost
 * claim rolls the probe back. The probe attempt id is stamped into the trip
 * evidence; the tick evaluation (loop-breaker.ts) resolves it from the
 * attempt's outcome.
 */

export const SELF_HEAL_DISPATCH_LIMIT = 20;
/** Below this, the next candidate could not finish its GitHub calls. */
const MIN_CANDIDATE_BUDGET_MS = 5_000;
const PRE_MINT_INSTALLATION_KEY = "pending";
/**
 * The half-open probe lease covers a fix run up to its draft open (dispatch,
 * box, finding check, opener retries). The tick evaluation resolves the probe
 * long before; an expired lease only lets the next claim take the probe.
 */
export const FIX_PROBE_LEASE_MS = 6 * 3_600_000;

/** The GitHub facts the dispatcher needs about one repo, cached per tick. */
export interface RepoGithubProbe {
  installationKey: string;
  /** The fixLoop capability preflight passed. */
  capabilitiesOk: boolean;
  /** The repo's default branch, or null when GitHub could not answer. */
  readDefaultBranch: () => Promise<string | null>;
}

export type ProbeRepo = (args: {
  db: DB;
  organizationId: string;
  owner: string;
  repo: string;
  deadlineAt: Date;
}) => Promise<RepoGithubProbe | null>;

export interface SelfHealDispatcherDeps {
  isLoopEnabled: (db: DB) => Promise<boolean>;
  listFixReady: typeof listFixReadyFindings;
  admit: typeof admitSelfHealRun;
  loadContext: typeof loadSelfHealContext;
  probeRepo: ProbeRepo;
  getBreakerState: typeof getBreakerState;
  listIssueAutomations: typeof getIssueAutomationsForRepo;
  listPullRequestAutomations: typeof getPullRequestAutomationsForRepo;
  claim: typeof claimFixAttempt;
  acquireProbe: typeof acquireHalfOpenProbe;
  recordProbe: typeof recordProbeAttempt;
  runFix: typeof runAuditFixAutomation;
  releaseSlot: typeof releaseSelfHealSlot;
  updateFinding: typeof updateFinding;
  botLogin: () => string;
  log: (line: string) => void;
  error: (message: string, fields: Record<string, unknown>) => void;
  capture: (event: string, properties: Record<string, string>) => void;
  now: () => Date;
}

export interface SelfHealDispatchResult {
  dispatched: string | null;
  considered: number;
  deferred?: string;
}

function errorText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** Call deps without a breaker override: the shared breaker model is used. */
type ProbeCallDeps = Omit<SelfHealCallDeps, "breaker">;

function callDepsFor(db: DB): ProbeCallDeps {
  return {
    db,
    now: () => new Date(),
    log: (message, fields) =>
      Object.keys(fields).length === 0
        ? console.log(message)
        : console.log(message, fields),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    rand: Math.random,
  };
}

/**
 * The production probe: one token mint, the fixLoop capability preflight
 * (latch rows double as its 1 h cache), and a lazy `repos.get` for the
 * default branch through withSelfHealCall with the preflight timeout.
 */
export function createRepoGithubProbe({
  mint = createSelfHealOctokit,
  preflight = preflightCapabilities,
  callDeps = callDepsFor,
}: {
  mint?: typeof createSelfHealOctokit;
  preflight?: typeof preflightCapabilities;
  callDeps?: (db: DB) => ProbeCallDeps;
} = {}): ProbeRepo {
  return async ({ db, organizationId, owner, repo, deadlineAt }) => {
    const deps = callDeps(db);
    let octokit: Octokit;
    let installationKey: string;
    try {
      const minted = await mint({ owner, repo });
      octokit = minted.octokit;
      installationKey = String(minted.installationId);
    } catch (error) {
      console.error("[self-heal] dispatcher token mint failed", {
        repo: `${owner}/${repo}`,
        error: errorText(error),
      });
      return null;
    }
    const capability = await preflight({
      organizationId,
      installationKey,
      owner,
      repo,
      capability: "fixLoop",
      deadlineAt,
      deps,
    });
    if (!capability.ok && "unavailable" in capability) return null;
    return {
      installationKey,
      capabilitiesOk: capability.ok,
      readDefaultBranch: async () => {
        const result = await withSelfHealCall({
          kind: "preflight",
          organizationId,
          installationKey,
          signalName: "gh_repo_get",
          permission: "contents",
          deadlineAt,
          deps,
          call: async (signal) => {
            const response = await octokit.rest.repos.get({
              owner,
              repo,
              request: { signal },
            });
            return {
              data: response.data.default_branch,
              status: response.status,
              headers: response.headers,
            };
          },
        });
        return result.ok && result.data ? result.data : null;
      },
    };
  };
}

export function defaultSelfHealDispatcherDeps(): SelfHealDispatcherDeps {
  return {
    isLoopEnabled: isSelfHealLoopEnabled,
    listFixReady: listFixReadyFindings,
    admit: admitSelfHealRun,
    loadContext: loadSelfHealContext,
    probeRepo: createRepoGithubProbe(),
    getBreakerState,
    listIssueAutomations: getIssueAutomationsForRepo,
    listPullRequestAutomations: getPullRequestAutomationsForRepo,
    claim: claimFixAttempt,
    acquireProbe: acquireHalfOpenProbe,
    recordProbe: recordProbeAttempt,
    runFix: runAuditFixAutomation,
    releaseSlot: releaseSelfHealSlot,
    updateFinding,
    botLogin: resolveBotLogin,
    log: (line) => console.log(line),
    error: (message, fields) => console.error(message, fields),
    capture: (event, properties) =>
      getPostHogServer().capture({
        distinctId: "self-heal-dispatcher",
        event,
        properties,
      }),
    now: () => new Date(),
  };
}

/** The repo's enabled audit-fix issue automation (newest first). */
export function isAuditFixAutomation(automation: Automation): boolean {
  const action = automation.action;
  return (
    automation.triggerType === "issue" &&
    action?.type === "skill_message" &&
    action.config.skillName.trim().toLowerCase() === AUDIT_FIX_SKILL_NAME
  );
}

/**
 * REV-01: the PR the fix loop marks ready (a `ready_for_review` event, which
 * the webhook maps to `on.open`) is reviewed only when the automation fires
 * on open and matches the bot as author: every author, or the bot login in
 * the other-authors list. No GitHub call.
 */
export function reviewsBotPullRequests(
  automation: Automation,
  botLogin: string,
): boolean {
  if (automation.triggerType !== "pull_request") return false;
  const config = automation.triggerConfig as PullRequestTriggerConfig;
  if (config.on?.open !== true) return false;
  if (config.filter?.includeAllAuthors === true) return true;
  if (config.filter?.includeOtherAuthors !== true) return false;
  const authors = (config.filter.otherAuthors ?? "")
    .split(",")
    .map((author) => author.trim().toLowerCase())
    .filter(Boolean);
  return authors.includes(botLogin.trim().toLowerCase());
}

interface BreakerScope {
  scopeKind: BreakerScopeKind;
  scopeKey: string;
}

/** Thrown inside the claim transaction to roll back a probe already taken. */
class ClaimAborted extends Error {
  constructor(readonly reason: string) {
    super(`fix claim aborted: ${reason}`);
    this.name = "ClaimAborted";
  }
}

const REFUSAL_FOR_KIND: Partial<Record<BreakerScopeKind, string>> = {
  loop_fix: "loop_fix_open",
  exec_plane: "exec_plane_open",
  hatchet_dispatch: "hatchet_dispatch_open",
};

/** Open and paused_manual refuse; half_open admits one probe. */
function blocks(row: BreakerRow): boolean {
  return row.state === "open" || row.state === "paused_manual";
}

async function breakerStateInTx(
  tx: SelfHealTx,
  organizationId: string,
  scope: BreakerScope,
): Promise<BreakerRow["state"]> {
  const [row] = await tx
    .select({ state: selfHealBreaker.state })
    .from(selfHealBreaker)
    .where(
      and(
        eq(selfHealBreaker.organizationId, organizationId),
        eq(selfHealBreaker.scopeKind, scope.scopeKind),
        eq(selfHealBreaker.scopeKey, scope.scopeKey),
      ),
    )
    .limit(1);
  return row?.state ?? "closed";
}

type CandidateOutcome =
  | { kind: "next" }
  | { kind: "dispatched"; threadId: string }
  | { kind: "stop" };

export async function runSelfHealDispatcher({
  db,
  now,
  deadlineAt,
  deps = defaultSelfHealDispatcherDeps(),
}: {
  db: DB;
  now: Date;
  deadlineAt: Date;
  deps?: SelfHealDispatcherDeps;
}): Promise<SelfHealDispatchResult> {
  const result: SelfHealDispatchResult = { dispatched: null, considered: 0 };
  try {
    if (!(await deps.isLoopEnabled(db))) return result;

    const candidates = await deps.listFixReady({
      db,
      limit: SELF_HEAL_DISPATCH_LIMIT,
    });
    const first = candidates[0];
    if (!first) return result;

    // Review first, then the single box slot. A deferral takes nothing.
    try {
      const admission = await deps.admit({
        db,
        organizationId: first.organizationId,
        holderKind: "fix",
        now,
        context: {
          repoFullName: first.repoFullName,
          fingerprint: first.fingerprint,
        },
        log: deps.log,
      });
      if (!admission.admitted) return { ...result, deferred: admission.reason };
    } catch (error) {
      deps.error("[self-heal] dispatcher admission failed — deferred", {
        error: errorText(error),
      });
      return { ...result, deferred: "admission_error" };
    }

    const probes = new Map<string, Promise<RepoGithubProbe | null>>();
    const branches = new Map<string, Promise<string | null>>();
    for (const finding of candidates) {
      if (
        deadlineAt.getTime() - deps.now().getTime() <
        MIN_CANDIDATE_BUDGET_MS
      ) {
        break;
      }
      result.considered += 1;
      let outcome: CandidateOutcome;
      try {
        outcome = await considerCandidate({
          db,
          now,
          deadlineAt,
          deps,
          finding,
          probes,
          branches,
        });
      } catch (error) {
        deps.error("[self-heal] dispatcher candidate failed", {
          findingId: finding.id,
          error: errorText(error),
        });
        outcome = { kind: "next" };
      }
      if (outcome.kind === "dispatched") {
        return { ...result, dispatched: outcome.threadId };
      }
      // runAuditFixAutomation already released the slot on its way out.
      if (outcome.kind === "stop") return result;
    }

    await deps.releaseSlot({ db });
    return result;
  } catch (error) {
    deps.error("[self-heal] dispatcher failed", { error: errorText(error) });
    try {
      await deps.releaseSlot({ db });
    } catch (releaseError) {
      deps.error("[self-heal] dispatcher could not release the slot", {
        error: errorText(releaseError),
      });
    }
    return result;
  }
}

async function considerCandidate({
  db,
  now,
  deadlineAt,
  deps,
  finding,
  probes,
  branches,
}: {
  db: DB;
  now: Date;
  deadlineAt: Date;
  deps: SelfHealDispatcherDeps;
  finding: AuditFindingRow;
  probes: Map<string, Promise<RepoGithubProbe | null>>;
  branches: Map<string, Promise<string | null>>;
}): Promise<CandidateOutcome> {
  const { organizationId, repoFullName } = finding;
  const repoKey = `${organizationId}\u0000${repoFullName}`;
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    throw new Error("malformed repo slug on a fix-ready finding");
  }

  const record = async (
    decision: SelfHealDecision | SelfHealWouldDecision,
    reason: string,
    mode: "off" | "dry-run" | "on",
  ): Promise<void> => {
    try {
      logSelfHealDecision(
        { log: deps.log, capture: deps.capture },
        {
          organizationId,
          repoFullName,
          runId: "-",
          fingerprint: finding.fingerprint,
          decision,
          reason,
          mode,
        },
      );
    } catch (error) {
      deps.error("[self-heal] decision log failed", {
        error: errorText(error),
      });
    }
    if (
      finding.lastDecision === decision &&
      finding.lastDecisionReason === reason
    ) {
      return;
    }
    await deps.updateFinding({
      db,
      organizationId,
      id: finding.id,
      patch: { lastDecision: decision, lastDecisionReason: reason },
    });
  };

  // Every switch that needs no GitHub call first.
  const pre = await deps.loadContext({
    db,
    organizationId,
    repoFullName,
    installationKey: PRE_MINT_INSTALLATION_KEY,
  });
  let context = pre;
  let probe: RepoGithubProbe | null = null;
  if (resolveSelfHealEffective(pre).mode === "on") {
    let pending = probes.get(repoKey);
    if (!pending) {
      pending = deps.probeRepo({
        db,
        organizationId,
        owner,
        repo,
        deadlineAt,
      });
      probes.set(repoKey, pending);
    }
    probe = await pending;
    if (probe === null) {
      await record("dispatch", "github_unavailable", "on");
      return { kind: "next" };
    }
    // The preflight may have just moved a permission latch: resolve again.
    context = await deps.loadContext({
      db,
      organizationId,
      repoFullName,
      installationKey: probe.installationKey,
    });
  }
  const loopKey = normalizeRepo(repoFullName);
  const [loopFix, execPlane, hatchetDispatch, issueAutomations, prAutomations] =
    await Promise.all([
      deps.getBreakerState({
        db,
        organizationId,
        scopeKind: "loop_fix",
        scopeKey: loopKey,
      }),
      deps.getBreakerState({
        db,
        organizationId,
        scopeKind: "exec_plane",
        scopeKey: "*",
      }),
      deps.getBreakerState({
        db,
        organizationId,
        scopeKind: "hatchet_dispatch",
        scopeKey: "*",
      }),
      deps.listIssueAutomations({ db, repoFullName }),
      deps.listPullRequestAutomations({ db, repoFullName }),
    ]);
  const fixAutomation =
    issueAutomations.find(
      (automation) =>
        automation.organizationId === organizationId &&
        isAuditFixAutomation(automation),
    ) ?? null;
  const botLogin = deps.botLogin();
  const reviewAutomationMatchesBot = prAutomations.some(
    (automation) =>
      automation.organizationId === organizationId &&
      reviewsBotPullRequests(automation, botLogin),
  );

  // A half-open loop_fix admits one probe run (taken with the claim below);
  // the context's own read only narrows further.
  const loopFixHalfOpen = loopFix.state === "half_open";
  const effective = resolveSelfHealEffective({
    ...context,
    breakers: {
      ...context.breakers,
      loopFixOpen:
        blocks(loopFix) || (context.breakers.loopFixOpen && !loopFixHalfOpen),
    },
  });

  const verdict = evaluateFixTrigger({
    effective,
    capabilitiesOk: probe?.capabilitiesOk ?? true,
    breakers: {
      execPlaneOpen: blocks(execPlane),
      hatchetDispatchOpen: blocks(hatchetDispatch),
    },
    fixAutomation: fixAutomation
      ? { id: fixAutomation.id, userId: fixAutomation.userId }
      : null,
    reviewAutomationMatchesBot,
    finding,
    settings: context.resolved.settings,
    now,
  });
  if (!verdict.ok) {
    await record(
      verdict.wouldDispatch ? "would_dispatch" : "dispatch",
      verdict.reason,
      effective.mode,
    );
    return { kind: "next" };
  }
  // evaluateFixTrigger passed, so the mode is on and the probe ran.
  if (probe === null || fixAutomation === null) {
    throw new Error("fix trigger passed without a probe or an automation");
  }

  let branch = branches.get(repoKey);
  if (!branch) {
    branch = probe.readDefaultBranch();
    branches.set(repoKey, branch);
  }
  const baseBranch = await branch;
  if (baseBranch === null) {
    await record("dispatch", "github_unavailable", "on");
    return { kind: "next" };
  }

  const { issueNumber } = finding;
  if (issueNumber === null) {
    await record("dispatch", "claim_refused", "on");
    return { kind: "next" };
  }
  const scopes: Array<BreakerScope & { row: BreakerRow }> = [
    { scopeKind: "loop_fix", scopeKey: loopKey, row: loopFix },
    { scopeKind: "exec_plane", scopeKey: "*", row: execPlane },
    { scopeKind: "hatchet_dispatch", scopeKey: "*", row: hatchetDispatch },
  ];
  const halfOpen = scopes.filter((scope) => scope.row.state === "half_open");
  let claimed: Awaited<ReturnType<typeof deps.claim>>;
  try {
    claimed = await withSelfHealTx(db, async (tx) => {
      // The claim CAS also requires the breakers it read as closed to still
      // be closed ("AND <breaker allows>").
      for (const scope of scopes) {
        if (scope.row.state !== "closed") continue;
        if ((await breakerStateInTx(tx, organizationId, scope)) !== "closed") {
          throw new ClaimAborted(
            REFUSAL_FOR_KIND[scope.scopeKind] ?? "breaker_open",
          );
        }
      }
      for (const scope of halfOpen) {
        const taken = await deps.acquireProbe({
          db,
          organizationId,
          scopeKind: scope.scopeKind,
          scopeKey: scope.scopeKey,
          leaseMs: FIX_PROBE_LEASE_MS,
          now,
          tx,
        });
        if (!taken) throw new ClaimAborted("breaker_half_open_probe_taken");
      }
      const won = await deps.claim({
        db,
        organizationId,
        findingId: finding.id,
        maxAttempts: context.resolved.settings.maxAttempts,
        cooldownMin: context.resolved.settings.cooldownMin,
        branchFor: (attemptNo) =>
          fixBranchName({
            issueNumber,
            fingerprint: finding.fingerprint,
            attemptNo,
          }),
        now,
        tx,
      });
      // A lost claim must give the probe back: roll the transaction back.
      if (won === null) throw new ClaimAborted("claim_refused");
      for (const scope of halfOpen) {
        await deps.recordProbe({
          tx,
          organizationId,
          scopeKind: scope.scopeKind,
          scopeKey: scope.scopeKey,
          attemptId: won.attempt.id,
        });
      }
      return won;
    });
  } catch (error) {
    if (!(error instanceof ClaimAborted)) throw error;
    await record("dispatch", error.reason, "on");
    return { kind: "next" };
  }
  if (claimed === null) {
    await record("dispatch", "claim_refused", "on");
    return { kind: "next" };
  }
  for (const scope of halfOpen) {
    deps.log(
      `[self-heal:breaker] probe org=${organizationId} scopeKind=${scope.scopeKind} scopeKey=${scope.scopeKey} probeId=${claimed.attempt.id} outcome=taken`,
    );
  }

  const started = await deps.runFix({
    db,
    automation: { id: fixAutomation.id, userId: fixAutomation.userId },
    finding: claimed.finding,
    attempt: claimed.attempt,
    baseBranch,
  });
  if (started === null) return { kind: "stop" };
  await deps.updateFinding({
    db,
    organizationId,
    id: finding.id,
    patch: { lastDecision: "dispatch", lastDecisionReason: "started" },
  });
  return { kind: "dispatched", threadId: started.threadId };
}
