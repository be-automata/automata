import type { Octokit } from "octokit";

import {
  absentAsNull,
  type CheckRunLike,
  type CommitStatusLike,
  type GateSource,
  type RawBranch,
  type RawRule,
  requiredCheckNamesFrom,
  selectGateSource,
  summarizeCheckRuns,
} from "@/server-lib/audit/required-checks";

/**
 * The CI verdict of one delivery-PR head (#509), judged exactly like a
 * self-heal draft (required-checks.ts): branch protection or rulesets when the
 * base has required checks, else every check on the head with the settle
 * window, else no repo CI after 10 minutes.
 *
 * Reads go straight to the App client, outside the self-heal breaker: a
 * delivery read failing must never trip self-heal. A 403/404 on the
 * protection reads means "no required checks"; any other error propagates and
 * the evaluator retries on a later trigger.
 */
export type DeliveryHeadCi =
  | { state: "pending"; gateSource: GateSource | null }
  | {
      state: "success" | "failure" | "infra";
      gateSource: GateSource;
      /** Failing (failure) or infra-failed (infra) check names. */
      failing: string[];
      /** True when the head has no repo CI at all (gate finding-check-only). */
      noCi: boolean;
    };

export async function readDeliveryHeadCi({
  octokit,
  owner,
  repo,
  sha,
  baseRef,
  pushedAt,
  now,
  signal,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
  sha: string;
  baseRef: string;
  /** When this head was first seen: the no-CI window runs from here. */
  pushedAt: Date;
  now: Date;
  signal?: AbortSignal;
}): Promise<DeliveryHeadCi> {
  const request = signal ? { signal } : {};
  const [branch, rules, runs, statuses] = await Promise.all([
    absentAsNull(async () => {
      const res = await octokit.rest.repos.getBranch({
        owner,
        repo,
        branch: baseRef,
        request,
      });
      return { ...res, data: res.data as unknown as RawBranch };
    }),
    absentAsNull(async () => {
      const res = await octokit.rest.repos.getBranchRules({
        owner,
        repo,
        branch: baseRef,
        per_page: 100,
        request,
      });
      return { ...res, data: res.data as unknown as RawRule[] };
    }),
    octokit.rest.checks.listForRef({
      owner,
      repo,
      ref: sha,
      filter: "latest",
      per_page: 100,
      request,
    }),
    absentAsNull(async () => {
      const res = await octokit.rest.repos.getCombinedStatusForRef({
        owner,
        repo,
        ref: sha,
        per_page: 100,
        request,
      });
      return {
        ...res,
        data: res.data.statuses as unknown as CommitStatusLike[],
      };
    }),
  ]);
  const required = requiredCheckNamesFrom(branch.data, rules.data);
  const checkRuns = runs.data.check_runs as unknown as CheckRunLike[];
  const commitStatuses = statuses.data ?? [];
  const source = selectGateSource({
    requiredNames: required,
    checkRuns,
    statuses: commitStatuses,
    pushedAt,
    now,
  });
  if (source === "pending") return { state: "pending", gateSource: null };
  const verdict = summarizeCheckRuns({
    source,
    required,
    checkRuns,
    statuses: commitStatuses,
    now,
  });
  if (verdict.state === "pending") {
    return { state: "pending", gateSource: source };
  }
  return {
    state: verdict.state,
    gateSource: source,
    failing: verdict.failing ?? [],
    noCi: source === "finding-check-only",
  };
}
