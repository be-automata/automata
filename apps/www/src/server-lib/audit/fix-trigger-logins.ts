import type { DB } from "@terragon/shared/db";
import { getIssueAutomationsForRepo } from "@terragon/shared/model/automations";
import { getGitHubAccountIdForUser } from "@terragon/shared/model/user";

import { resolveBotLogin } from "../review/bot-login";
import { isAuditFixAutomation } from "./self-heal-dispatcher";
import { createSelfHealOctokit } from "./self-heal-octokit";

/**
 * The logins that TRIGGER a self-heal fix PR (R5 merge rate): the platform
 * bot, and the GitHub login of the owner of the repo's audit-fix automation.
 * A merge by either does not count as a human merge.
 *
 * The owner's login is not stored, so it is read once from GitHub
 * (`GET /user/{account_id}` with the App installation token) and cached per
 * process. Any failure — no automation, no linked GitHub account, a token or
 * API error, a timeout — omits the owner, and the metrics then report the
 * merge-rate basis as bot-only. The lookup never throws.
 */

export const OWNER_LOGIN_TIMEOUT_MS = 3_000;
export const OWNER_LOGIN_CACHE_MS = 60 * 60 * 1000;

export interface FixTriggerLoginDeps {
  botLogin: () => string;
  listIssueAutomations: typeof getIssueAutomationsForRepo;
  getGitHubAccountId: typeof getGitHubAccountIdForUser;
  /** The GitHub login of a numeric account id; null when unknown. */
  lookupLogin: (args: {
    repoFullName: string;
    accountId: string;
  }) => Promise<string | null>;
  error: (message: string, fields: Record<string, unknown>) => void;
  now: () => number;
}

interface CachedLogin {
  login: string;
  expiresAt: number;
}

const loginCache = new Map<string, CachedLogin>();

/** Test hook: forget cached owner logins. */
export function clearOwnerLoginCache(): void {
  loginCache.clear();
}

async function lookupLoginViaApp({
  repoFullName,
  accountId,
}: {
  repoFullName: string;
  accountId: string;
}): Promise<string | null> {
  const id = Number(accountId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return null;
  const signal = AbortSignal.timeout(OWNER_LOGIN_TIMEOUT_MS);
  const { octokit } = await createSelfHealOctokit({ owner, repo, signal });
  const response = await octokit.request("GET /user/{account_id}", {
    account_id: id,
    request: { signal },
  });
  const login: unknown = (response.data as { login?: unknown }).login;
  return typeof login === "string" && login.trim() !== "" ? login : null;
}

export function defaultFixTriggerLoginDeps(): FixTriggerLoginDeps {
  return {
    botLogin: resolveBotLogin,
    listIssueAutomations: getIssueAutomationsForRepo,
    getGitHubAccountId: getGitHubAccountIdForUser,
    lookupLogin: lookupLoginViaApp,
    error: console.error,
    now: () => Date.now(),
  };
}

async function ownerLogin({
  db,
  organizationId,
  repoFullName,
  deps,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  deps: FixTriggerLoginDeps;
}): Promise<string | null> {
  const automations = await deps.listIssueAutomations({ db, repoFullName });
  const fixAutomation = automations.find(
    (automation) =>
      automation.organizationId === organizationId &&
      isAuditFixAutomation(automation),
  );
  if (!fixAutomation) return null;
  const accountId = await deps.getGitHubAccountId({
    db,
    userId: fixAutomation.userId,
  });
  if (!accountId) return null;

  const cached = loginCache.get(accountId);
  if (cached && cached.expiresAt > deps.now()) return cached.login;
  const login = await deps.lookupLogin({ repoFullName, accountId });
  if (login !== null) {
    loginCache.set(accountId, {
      login,
      expiresAt: deps.now() + OWNER_LOGIN_CACHE_MS,
    });
  }
  return login;
}

export async function resolveFixTriggerLogins({
  db,
  organizationId,
  repoFullName,
  deps = defaultFixTriggerLoginDeps(),
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  deps?: FixTriggerLoginDeps;
}): Promise<string[]> {
  const logins = [deps.botLogin()];
  try {
    const owner = await ownerLogin({ db, organizationId, repoFullName, deps });
    if (owner !== null) logins.push(owner);
  } catch (e) {
    deps.error("[self-heal] fix automation owner login lookup failed", {
      repoFullName,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return logins;
}
