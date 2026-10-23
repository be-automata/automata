import { createPrivateKey, createSign } from "node:crypto";

import type { CanaryLane } from "./thread-spec";

/**
 * GitHub App installation-token minting for the canary dispatcher. DEV ONLY.
 *
 * The App key on the throwaway box can mint for EVERY repository of the
 * organisation, so two fences stand between it and a token:
 *
 *  1. the repo allowlist (`CANARY_REPOS`, default the container-canary repo):
 *     a repo outside it is refused BEFORE the key file is even read;
 *  2. the token request itself is restricted to that one repository and to
 *     the minimum permissions of the lane, and the RESPONSE is checked to say
 *     the same (a token GitHub widened is refused, never used).
 */

export const DEFAULT_CANARY_REPOS = "be-automata/automata-container-canary";

export class CanaryRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanaryRefusal";
  }
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The allowlist, lower-cased. Unset or blank ⇒ the default canary repo only. */
export function parseRepoAllowlist(raw: string | undefined): Set<string> {
  const text = raw?.trim() ? raw : DEFAULT_CANARY_REPOS;
  const out = new Set<string>();
  for (const entry of text.split(/[\s,]+/)) {
    const e = entry.trim().toLowerCase();
    if (e === "") continue;
    if (!REPO_RE.test(e) || e.includes("*")) {
      throw new CanaryRefusal(
        `CANARY_REPOS entry ${JSON.stringify(entry)} is not an owner/name slug`,
      );
    }
    out.add(e);
  }
  return out;
}

/** Throws CanaryRefusal unless `repoFullName` is exactly an allowlisted slug. */
export function assertRepoAllowed(
  repoFullName: string,
  allowlist: ReadonlySet<string>,
): { owner: string; name: string } {
  if (!REPO_RE.test(repoFullName)) {
    throw new CanaryRefusal(
      `--repo ${JSON.stringify(repoFullName)} is not an owner/name slug`,
    );
  }
  if (!allowlist.has(repoFullName.toLowerCase())) {
    throw new CanaryRefusal(
      `--repo ${repoFullName} is not in CANARY_REPOS (${[...allowlist].join(", ")}); refusing to mint a token for it`,
    );
  }
  const [owner, name] = repoFullName.split("/") as [string, string];
  return { owner, name };
}

export type TokenPermissions = Record<string, "read" | "write">;

/**
 * The minimum a lane's run needs. Review: the worker only clones (the
 * verdict is posted by www, which ADR-013 does not change), so read only.
 * Task / mention: push (contents), comment and open/update a PR
 * (pull_requests, issues), plus the metadata every token carries.
 */
export function lanePermissions(lane: CanaryLane): TokenPermissions {
  if (lane === "review") {
    return { contents: "read", metadata: "read", pull_requests: "read" };
  }
  return {
    contents: "write",
    metadata: "read",
    pull_requests: "write",
    issues: "write",
  };
}

/** The POST /app/installations/{id}/access_tokens body: ONE repo, the lane's permissions. */
export function installationTokenRequestBody(
  repoName: string,
  lane: CanaryLane,
): { repositories: [string]; permissions: TokenPermissions } {
  if (!/^[A-Za-z0-9_.-]+$/.test(repoName)) {
    throw new CanaryRefusal("repository name has an invalid character set");
  }
  return { repositories: [repoName], permissions: lanePermissions(lane) };
}

const RANK = { read: 1, write: 2 } as const;

/**
 * Refuse a minted token whose response is wider than what was asked: a
 * repository selection other than exactly the one repo, or any permission
 * not requested (or above the requested level).
 */
export function assertTokenResponseRestricted(
  response: unknown,
  requested: { repositories: [string]; permissions: TokenPermissions },
): { token: string; expiresAt: string } {
  const r = response as {
    token?: unknown;
    expires_at?: unknown;
    repository_selection?: unknown;
    repositories?: Array<{ name?: unknown }>;
    permissions?: Record<string, unknown>;
  } | null;
  if (!r || typeof r.token !== "string" || typeof r.expires_at !== "string") {
    throw new CanaryRefusal("GitHub token response carries no token");
  }
  const names = Array.isArray(r.repositories)
    ? r.repositories.map((x) => String(x?.name ?? "").toLowerCase())
    : [];
  if (
    r.repository_selection !== "selected" ||
    names.length !== 1 ||
    names[0] !== requested.repositories[0].toLowerCase()
  ) {
    throw new CanaryRefusal(
      "GitHub minted a token that is not restricted to the one requested repository",
    );
  }
  for (const [perm, level] of Object.entries(r.permissions ?? {})) {
    const asked = requested.permissions[perm];
    if (
      asked === undefined ||
      (level !== "read" && level !== "write") ||
      RANK[level] > RANK[asked]
    ) {
      throw new CanaryRefusal(
        `GitHub minted a token with an unrequested permission (${perm}=${String(level)})`,
      );
    }
  }
  return { token: r.token, expiresAt: r.expires_at };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** The App JWT (RS256, 9 minutes, backdated 60 s for clock skew — GitHub's guidance). */
export function signAppJwt(
  appId: string,
  privateKeyPem: string,
  now: Date = new Date(),
): string {
  if (!/^\d+$/.test(appId)) {
    throw new CanaryRefusal("CANARY_GH_APP_ID must be the numeric App id");
  }
  const iat = Math.floor(now.getTime() / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat, exp: iat + 9 * 60, iss: appId }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(createPrivateKey(privateKeyPem));
  return `${header}.${payload}.${base64url(signature)}`;
}

const GITHUB_API = "https://api.github.com";

function githubHeaders(auth: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: auth,
    "User-Agent": "automata-canary-dispatch",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Mint a single-repo, lane-scoped installation token. The allowlist check is
 * the CALLER's (dispatch.mts runs it before reading the key); this function
 * re-checks the response, never the request.
 */
export async function mintInstallationToken({
  appId,
  installationId,
  privateKeyPem,
  repoName,
  lane,
  fetchImpl = fetch,
}: {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  repoName: string;
  lane: CanaryLane;
  fetchImpl?: typeof fetch;
}): Promise<{ token: string; expiresAt: string }> {
  if (!/^\d+$/.test(installationId)) {
    throw new CanaryRefusal(
      "CANARY_GH_INSTALLATION_ID must be the numeric installation id",
    );
  }
  const body = installationTokenRequestBody(repoName, lane);
  const res = await fetchImpl(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        ...githubHeaders(`Bearer ${signAppJwt(appId, privateKeyPem)}`),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    // Status only: the body can echo the request.
    throw new Error(`GitHub token mint failed: HTTP ${res.status}`);
  }
  return assertTokenResponseRestricted(await res.json(), body);
}

/** The PR's head and base branch names, read with the minted token. */
export async function readPullRequestRefs({
  token,
  repoFullName,
  prNumber,
  fetchImpl = fetch,
}: {
  token: string;
  repoFullName: string;
  prNumber: number;
  fetchImpl?: typeof fetch;
}): Promise<{ head: string; base: string }> {
  const res = await fetchImpl(
    `${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}`,
    { headers: githubHeaders(`token ${token}`) },
  );
  if (!res.ok) {
    throw new Error(`GitHub PR read failed: HTTP ${res.status}`);
  }
  const pr = (await res.json()) as {
    head?: { ref?: unknown };
    base?: { ref?: unknown };
  };
  if (typeof pr.head?.ref !== "string" || typeof pr.base?.ref !== "string") {
    throw new Error("GitHub PR read returned no head/base ref");
  }
  return { head: pr.head.ref, base: pr.base.ref };
}

/** Best-effort revoke of a token the dispatch minted but never handed over. */
export async function revokeInstallationToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await fetchImpl(`${GITHUB_API}/installation/token`, {
    method: "DELETE",
    headers: githubHeaders(`token ${token}`),
  }).catch(() => undefined);
}
