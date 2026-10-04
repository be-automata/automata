import type { Octokit } from "octokit";

import { getRepoInstallationPermissions } from "@terragon/shared/github-app";
import * as breakerModel from "@terragon/shared/model/self-heal-breaker";
import type { PermissionName } from "@terragon/shared/model/self-heal-breaker";

import {
  withSelfHealCall,
  type GithubResponse,
  type SelfHealBreakerOps,
  type SelfHealCallDeps,
} from "./with-self-heal-call";

/**
 * Pre-effect checks for the self-heal lane. Both preflights go through
 * withSelfHealCall (kind "preflight", 5 s) and fail closed: an unreachable
 * GitHub yields `unavailable` / "unknown", never a latch and never a pass.
 *
 * Capability preflight: one `GET /repos/{o}/{r}/installation` (App JWT)
 * returns the installation's permissions. A permission below the required
 * level latches (PROT-style fail closed); a later preflight that sees it
 * satisfied clears the latch. The latch rows double as the cache: a row
 * updated within the last hour answers without a GitHub call.
 *
 * Protection preflight (PROT-01): reads the branch summary and the effective
 * branch rules. It never reads `/branches/{b}/protection`, which needs
 * administration:read that the App does not hold.
 */

export type SelfHealCapability = "writer" | "fixLoop";
export type PermissionLevel = "read" | "write";

export const SELF_HEAL_CAPABILITIES: Record<
  SelfHealCapability,
  ReadonlyArray<readonly [PermissionName, PermissionLevel]>
> = {
  writer: [["issues", "write"]],
  fixLoop: [
    ["pull_requests", "write"],
    ["contents", "write"],
    ["checks", "read"],
    ["actions", "read"],
  ],
};

export const PREFLIGHT_CACHE_MS = 60 * 60 * 1000;

export type PreflightBreakerOps = SelfHealBreakerOps &
  Pick<typeof breakerModel, "clearPermissionLatch">;

export type PreflightDeps = Omit<SelfHealCallDeps, "breaker"> & {
  breaker?: PreflightBreakerOps;
  getPermissions?: typeof getRepoInstallationPermissions;
};

export type CapabilityPreflight =
  | { ok: true; installationId: number }
  | { ok: false; missing: string[]; installationId: number }
  | { ok: false; unavailable: true };

function satisfies(
  actual: string | undefined,
  required: PermissionLevel,
): boolean {
  return required === "write"
    ? actual === "write"
    : actual === "read" || actual === "write";
}

/**
 * The missing permission set for `capability`. `installationKey` is the
 * stable key every other self-heal call of this installation uses, so the
 * latch rows written here are the ones the wrapper and the resolver read.
 */
export async function preflightCapabilities({
  organizationId,
  installationKey,
  owner,
  repo,
  capability,
  deadlineAt,
  deps,
}: {
  organizationId: string;
  installationKey: string;
  owner: string;
  repo: string;
  capability: SelfHealCapability;
  deadlineAt: Date;
  deps: PreflightDeps;
}): Promise<CapabilityPreflight> {
  const { db, now } = deps;
  const breaker: PreflightBreakerOps =
    deps.breaker ?? (breakerModel as unknown as PreflightBreakerOps);
  const required = SELF_HEAL_CAPABILITIES[capability];
  const knownInstallationId = Number(installationKey);

  // Cache: every required permission has a latch row touched within the hour.
  if (Number.isFinite(knownInstallationId)) {
    const rows = await Promise.all(
      required.map(([permission]) =>
        breaker.getBreakerState({
          db,
          organizationId,
          scopeKind: "permission",
          scopeKey: `${installationKey}:${permission}`,
        }),
      ),
    );
    const fresh = rows.every(
      (row) =>
        row.version >= 0 &&
        now().getTime() - row.updatedAt.getTime() < PREFLIGHT_CACHE_MS,
    );
    if (fresh) {
      const missing = required
        .filter((_, index) => rows[index]?.state !== "closed")
        .map(([permission]) => permission);
      return missing.length === 0
        ? { ok: true, installationId: knownInstallationId }
        : { ok: false, missing, installationId: knownInstallationId };
    }
  }

  const getPermissions = deps.getPermissions ?? getRepoInstallationPermissions;
  const result = await withSelfHealCall({
    kind: "preflight",
    organizationId,
    installationKey,
    signalName: "gh_preflight_installation",
    deadlineAt,
    deps,
    call: async (signal): Promise<GithubResponse<InstallationPermissions>> => ({
      data: await getPermissions(owner, repo, { signal }),
      status: 200,
      headers: {},
    }),
  });
  if (!result.ok) return { ok: false, unavailable: true };

  const { installationId, permissions } = result.data;
  const missing: string[] = [];
  for (const [permission, level] of required) {
    if (satisfies(permissions[permission], level)) {
      await breaker.clearPermissionLatch({
        db,
        organizationId,
        installationId: installationKey,
        permission,
        reason: "preflight_ok",
        now: now(),
      });
    } else {
      missing.push(permission);
      await breaker.setPermissionLatch({
        db,
        organizationId,
        installationId: installationKey,
        permission,
        reason: `preflight_${permissions[permission] ?? "absent"}`,
        now: now(),
      });
    }
  }
  return missing.length === 0
    ? { ok: true, installationId }
    : { ok: false, missing, installationId };
}

interface InstallationPermissions {
  installationId: number;
  permissions: Record<string, string | undefined>;
}

export type BranchProtectionResult = "protected" | "unprotected" | "unknown";

interface BranchSummary {
  protected?: boolean;
  protection?: {
    required_status_checks?: {
      contexts?: string[];
      checks?: unknown[];
    } | null;
  } | null;
}

interface BranchRule {
  type?: string;
  parameters?: { required_status_checks?: unknown[] } | null;
}

function classicHasChecks(branch: BranchSummary): boolean {
  const checks = branch.protection?.required_status_checks;
  return (
    (checks?.contexts?.length ?? 0) > 0 || (checks?.checks?.length ?? 0) > 0
  );
}

/**
 * PROT-01: "protected" only when the default branch is protected AND requires
 * at least one status check (classic summary or a required_status_checks
 * ruleset rule). Anything we could not read is "unknown" (fail closed).
 */
export async function preflightBranchProtection({
  octokit,
  organizationId,
  installationKey,
  owner,
  repo,
  defaultBranch,
  deadlineAt,
  deps,
}: {
  octokit: Octokit;
  organizationId: string;
  installationKey: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  deadlineAt: Date;
  deps: PreflightDeps;
}): Promise<BranchProtectionResult> {
  const branchResult = await withSelfHealCall({
    kind: "preflight",
    organizationId,
    installationKey,
    signalName: "gh_preflight_branch",
    deadlineAt,
    deps,
    call: async (signal) => {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/branches/{branch}",
        { owner, repo, branch: defaultBranch, request: { signal } },
      );
      return {
        data: response.data as BranchSummary,
        status: response.status,
        headers: response.headers as GithubResponse<unknown>["headers"],
      };
    },
  });
  if (!branchResult.ok) return "unknown";
  const branch = branchResult.data;
  if (branch.protected === true && classicHasChecks(branch)) return "protected";

  const rulesResult = await withSelfHealCall({
    kind: "preflight",
    organizationId,
    installationKey,
    signalName: "gh_preflight_rules",
    deadlineAt,
    deps,
    call: async (signal) => {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/rules/branches/{branch}",
        { owner, repo, branch: defaultBranch, request: { signal } },
      );
      return {
        data: response.data as BranchRule[],
        status: response.status,
        headers: response.headers as GithubResponse<unknown>["headers"],
      };
    },
  });
  let rules: BranchRule[];
  if (rulesResult.ok) {
    rules = rulesResult.data;
  } else if (rulesResult.outcome === "not_found") {
    rules = [];
  } else {
    return "unknown";
  }

  const rulesetChecks = rules.some(
    (rule) =>
      rule.type === "required_status_checks" &&
      (rule.parameters?.required_status_checks?.length ?? 0) > 0,
  );
  const rulesetPullRequest = rules.some((rule) => rule.type === "pull_request");
  const isProtected = branch.protected === true || rulesetPullRequest;
  const hasChecks = classicHasChecks(branch) || rulesetChecks;
  return isProtected && hasChecks ? "protected" : "unprotected";
}
