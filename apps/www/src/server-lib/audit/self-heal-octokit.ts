import { Octokit } from "octokit";

import {
  getInstallationToken,
  lookupInstallationId,
} from "@terragon/shared/github-app";

/**
 * The ONLY GitHub client the self-heal lane may construct (OCTO-01).
 *
 * The stock octokit client retries non-idempotent creates on 5xx (duplicate
 * issues and PRs) and sleeps 60 s on a secondary limit inside a ~30 s
 * waitUntil. Both are switched off here: retry is disabled and the throttle
 * handlers return false, so a rate limit surfaces as an error the caller
 * classifies (withSelfHealCall) and persists as a Postgres horizon instead of
 * sleeping in process.
 *
 * The shared per-call Octokit helpers in lib/github are forbidden in the
 * self-heal lane (they mint per call and keep the retry policy); a grep gate
 * enforces it. The token is the App
 * installation token only, so no write is ever attributed to a human.
 */
export const SELF_HEAL_OCTOKIT_OPTIONS = {
  retry: { enabled: false },
  throttle: {
    onRateLimit: () => false,
    onSecondaryRateLimit: () => false,
  },
} as const;

export const SELF_HEAL_TOKEN_MINT_TIMEOUT_MS = 5_000;

export interface SelfHealMintedToken {
  token: string;
  installationId: number;
}

export interface SelfHealOctokitDeps {
  mintToken: (
    owner: string,
    repo: string,
    options: { signal: AbortSignal },
  ) => Promise<SelfHealMintedToken>;
  OctokitCtor: typeof Octokit;
  fetch?: typeof fetch;
}

async function defaultMintToken(
  owner: string,
  repo: string,
  options: { signal: AbortSignal },
): Promise<SelfHealMintedToken> {
  const installationId = await lookupInstallationId(owner, repo, options);
  const token = await getInstallationToken(
    owner,
    repo,
    installationId,
    options,
  );
  return { token, installationId };
}

const DEFAULT_DEPS: SelfHealOctokitDeps = {
  mintToken: defaultMintToken,
  OctokitCtor: Octokit,
};

/**
 * One installation-token mint (bounded by a 5 s signal, also aborted when the
 * execution `signal` fires) and one retry-free client per execution.
 */
export async function createSelfHealOctokit({
  owner,
  repo,
  signal,
  deps = DEFAULT_DEPS,
}: {
  owner: string;
  repo: string;
  signal?: AbortSignal;
  deps?: SelfHealOctokitDeps;
}): Promise<{ octokit: Octokit; installationId: number }> {
  const timeout = AbortSignal.timeout(SELF_HEAL_TOKEN_MINT_TIMEOUT_MS);
  const mintSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const { token, installationId } = await deps.mintToken(owner, repo, {
    signal: mintSignal,
  });
  const octokit = new deps.OctokitCtor({
    auth: token,
    ...SELF_HEAL_OCTOKIT_OPTIONS,
    ...(deps.fetch ? { request: { fetch: deps.fetch } } : {}),
  });
  return { octokit, installationId };
}
