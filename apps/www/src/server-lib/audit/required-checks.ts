import type { Octokit } from "octokit";

import {
  classifyGithubOutcome,
  withSelfHealCall,
  type GithubResponse,
  type SelfHealCallDeps,
} from "./with-self-heal-call";

/**
 * The CI gate of a self-heal draft (GATE-01 step 4). Branch protection is
 * OPTIONAL hardening, never a precondition (09-CONTEXT): a free-plan account
 * cannot protect a private repo, so the gate SOURCE is chosen per head:
 *
 *  - `protection` — the default branch has required checks (classic
 *    protection or a required_status_checks ruleset): exactly those must
 *    succeed;
 *  - `all-checks` — no required checks, or protection unreadable (403/404):
 *    EVERY check run and commit status on the head must succeed, with a
 *    2-minute settle window after the last completion so a late-registering
 *    workflow is not skipped;
 *  - `finding-check-only` — no check at all appeared within 10 minutes of the
 *    push (a repo without CI): the worker's finding check is the gate.
 *
 * Reads go through withSelfHealCall (kind read). Pure helpers below decide.
 */

export type GateSource = "protection" | "all-checks" | "finding-check-only";

/** No check may register for this long after the last completion. */
export const ALL_CHECKS_SETTLE_MS = 120_000;
/** No check at all within this long of the push = a repo without CI. */
export const NO_CI_WINDOW_MS = 600_000;

export interface RequiredCheckVerdict {
  state: "pending" | "success" | "failure" | "infra";
  /** The failing (failure) or infra-failed (infra) check names. */
  failing?: string[];
}

/** The slice of a check run (GET commits/{ref}/check-runs) the gate reads. */
export interface CheckRunLike {
  id?: number;
  name: string;
  status: string;
  conclusion: string | null;
  completed_at?: string | null;
}

/** The slice of a combined-status entry (GET commits/{ref}/status). */
export interface CommitStatusLike {
  context: string;
  state: string;
  updated_at?: string | null;
}

export type RequiredChecksResult = { names: string[] } | { unavailable: true };

interface RawBranch {
  protection?: {
    required_status_checks?: {
      contexts?: string[] | null;
      checks?: Array<{ context?: string | null }> | null;
    } | null;
  } | null;
}

interface RawRule {
  type?: string;
  parameters?: {
    required_status_checks?: Array<{ context?: string | null }> | null;
  } | null;
}

/**
 * A 403 (free plan: "Upgrade to GitHub Pro") or 404 (no protection) on a
 * protection read means "no required checks", not an error and never a
 * permission latch. A rate-limit 403 is still a failure.
 */
function isProtectionAbsent(error: unknown): boolean {
  const kind = classifyGithubOutcome(error).kind;
  return kind === "permission" || kind === "not_found";
}

async function absentAsNull<T>(
  call: () => Promise<GithubResponse<T>>,
): Promise<GithubResponse<T | null>> {
  try {
    return await call();
  } catch (error: unknown) {
    if (isProtectionAbsent(error)) {
      return { data: null, status: 200, headers: {} };
    }
    throw error;
  }
}

/**
 * The default branch's required check names: classic protection (GET
 * branches/{b}, protection summary) merged with active rulesets (GET
 * rules/branches/{b}). 403/404 → []. A timeout or 5xx → unavailable (the
 * caller retries on a later evaluation; it never refuses a draft).
 */
export async function readRequiredChecks({
  octokit,
  owner,
  repo,
  defaultBranch,
  organizationId,
  installationKey,
  deadlineAt,
  deps,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
  defaultBranch: string;
  organizationId: string;
  installationKey: string;
  deadlineAt: Date;
  deps: SelfHealCallDeps;
}): Promise<RequiredChecksResult> {
  const read = <T>(call: (signal: AbortSignal) => Promise<GithubResponse<T>>) =>
    withSelfHealCall<T | null>({
      kind: "read",
      organizationId,
      installationKey,
      signalName: "gh_read",
      permission: "contents",
      deadlineAt,
      deps,
      call: (signal) => absentAsNull(() => call(signal)),
    });

  const [branch, rules] = await Promise.all([
    read<RawBranch>(async (signal) => {
      const res = await octokit.rest.repos.getBranch({
        owner,
        repo,
        branch: defaultBranch,
        request: { signal },
      });
      return { ...res, data: res.data as unknown as RawBranch };
    }),
    read<RawRule[]>(async (signal) => {
      const res = await octokit.rest.repos.getBranchRules({
        owner,
        repo,
        branch: defaultBranch,
        per_page: 100,
        request: { signal },
      });
      return { ...res, data: res.data as unknown as RawRule[] };
    }),
  ]);
  if (!branch.ok || !rules.ok) return { unavailable: true };

  const names = new Set<string>();
  const classic = branch.data?.protection?.required_status_checks;
  for (const context of classic?.contexts ?? []) names.add(context);
  for (const check of classic?.checks ?? []) {
    if (check.context) names.add(check.context);
  }
  for (const rule of rules.data ?? []) {
    if (rule.type !== "required_status_checks") continue;
    for (const check of rule.parameters?.required_status_checks ?? []) {
      if (check.context) names.add(check.context);
    }
  }
  return { names: [...names].sort() };
}

/**
 * Which gate this head is held to. `requiredNames` null = protection
 * unreadable for a transient reason (pending: retry next evaluation).
 */
export function selectGateSource({
  requiredNames,
  checkRuns,
  statuses,
  pushedAt,
  now,
}: {
  requiredNames: string[] | null;
  checkRuns: readonly CheckRunLike[];
  statuses: readonly CommitStatusLike[];
  pushedAt: Date;
  now: Date;
}): GateSource | "pending" {
  if (requiredNames === null) return "pending";
  if (requiredNames.length > 0) return "protection";
  if (checkRuns.length > 0 || statuses.length > 0) return "all-checks";
  return now.getTime() - pushedAt.getTime() >= NO_CI_WINDOW_MS
    ? "finding-check-only"
    : "pending";
}

type CheckState = "pending" | "success" | "failure" | "infra";

function checkRunState(run: CheckRunLike): CheckState {
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
    case "neutral":
    case "skipped":
      return "success";
    case "failure":
    case "timed_out":
    case "action_required":
      return "failure";
    case "cancelled":
    case "stale":
    case "startup_failure":
      return "infra";
    default:
      return "pending";
  }
}

function commitStatusState(status: CommitStatusLike): CheckState {
  switch (status.state) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    default:
      return "pending";
  }
}

interface GateEntry {
  name: string;
  state: CheckState;
  completedAt: number | null;
}

function timeOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** One entry per name: a rerun (higher id) supersedes the earlier run. */
function gateEntries(
  checkRuns: readonly CheckRunLike[],
  statuses: readonly CommitStatusLike[],
): Map<string, GateEntry> {
  const latestRun = new Map<string, CheckRunLike>();
  for (const run of checkRuns) {
    const seen = latestRun.get(run.name);
    if (!seen || (run.id ?? 0) >= (seen.id ?? 0)) latestRun.set(run.name, run);
  }
  const entries = new Map<string, GateEntry>();
  for (const run of latestRun.values()) {
    entries.set(run.name, {
      name: run.name,
      state: checkRunState(run),
      completedAt: timeOf(run.completed_at),
    });
  }
  for (const status of statuses) {
    if (entries.has(status.context)) continue;
    const state = commitStatusState(status);
    entries.set(status.context, {
      name: status.context,
      state,
      completedAt: state === "pending" ? null : timeOf(status.updated_at),
    });
  }
  return entries;
}

function aggregate(entries: readonly GateEntry[]): RequiredCheckVerdict {
  const failing = entries.filter((e) => e.state === "failure");
  if (failing.length > 0) {
    return { state: "failure", failing: failing.map((e) => e.name).sort() };
  }
  const infra = entries.filter((e) => e.state === "infra");
  if (infra.length > 0) {
    return { state: "infra", failing: infra.map((e) => e.name).sort() };
  }
  if (entries.some((e) => e.state === "pending")) return { state: "pending" };
  return { state: "success" };
}

/**
 * The CI verdict for one head under `source`. Failure beats infra beats
 * pending: a red check is final, a cancelled one is refunded, anything still
 * running waits. finding-check-only has no repo CI to judge: success.
 */
export function summarizeCheckRuns({
  source,
  required,
  checkRuns,
  statuses,
  now,
}: {
  source: GateSource;
  required: readonly string[];
  checkRuns: readonly CheckRunLike[];
  statuses: readonly CommitStatusLike[];
  now: Date;
}): RequiredCheckVerdict {
  if (source === "finding-check-only") return { state: "success" };
  const entries = gateEntries(checkRuns, statuses);

  if (source === "protection") {
    const judged: GateEntry[] = required.map(
      (name) =>
        entries.get(name) ?? { name, state: "pending", completedAt: null },
    );
    return aggregate(judged);
  }

  const all = [...entries.values()];
  if (all.length === 0) return { state: "pending" };
  const verdict = aggregate(all);
  if (verdict.state !== "success") return verdict;
  // A completed entry without a timestamp does not hold the window open.
  const lastCompletion = Math.max(...all.map((e) => e.completedAt ?? 0));
  return now.getTime() - lastCompletion >= ALL_CHECKS_SETTLE_MS
    ? verdict
    : { state: "pending" };
}
