import { App } from "@octokit/app";

let appInstance: App | null = null;

// Export for testing purposes only
export function resetAppInstance() {
  appInstance = null;
}

/**
 * Get or create GitHub App instance
 */
export function getGitHubApp(): App {
  if (appInstance) {
    return appInstance;
  }

  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || !privateKey) {
    throw new Error(
      "GitHub App configuration missing: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required",
    );
  }

  appInstance = new App({
    appId,
    privateKey: privateKey.replace(/\\n/g, "\n"), // Handle escaped newlines
  });

  return appInstance;
}

/** Optional per-call abort signal (self-heal passes a bounded one). */
export interface GitHubCallOptions {
  signal?: AbortSignal;
}

/** `{ request: { signal } }` only when a signal was given: callers without one are unchanged. */
function requestSignal(options?: GitHubCallOptions): {
  request?: { signal: AbortSignal };
} {
  return options?.signal ? { request: { signal: options.signal } } : {};
}

const NOT_INSTALLED_PREFIX = "GitHub App is not installed on repository";

function isNotInstalledError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.startsWith(NOT_INSTALLED_PREFIX)
  );
}

/** Rethrow a 404 from the installation lookup as the "not installed" error. */
function notInstalledOr(error: unknown, owner: string, repo: string): Error {
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 404
  ) {
    return new Error(`${NOT_INSTALLED_PREFIX} ${owner}/${repo}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The App installation id covering owner/repo. A 404 throws the same "not
 * installed" error as the minters. Exported so a caller minting several
 * tokens for one repo looks the installation up once and passes the id in.
 */
export async function lookupInstallationId(
  owner: string,
  repo: string,
  options?: GitHubCallOptions,
): Promise<number> {
  try {
    const { data: installation } = await getGitHubApp().octokit.request(
      "GET /repos/{owner}/{repo}/installation",
      {
        owner,
        repo,
        ...requestSignal(options),
      },
    );
    return installation.id;
  } catch (error: unknown) {
    throw notInstalledOr(error, owner, repo);
  }
}

/**
 * Get installation access token for a repository
 * @param owner Repository owner
 * @param repo Repository name
 * @param knownInstallationId The repo's installation id when the caller
 *   already looked it up (lookupInstallationId); otherwise looked up here
 * @returns Installation access token
 */
export async function getInstallationToken(
  owner: string,
  repo: string,
  knownInstallationId?: number,
  options?: GitHubCallOptions,
): Promise<string> {
  const app = getGitHubApp();

  try {
    // Get the installation for this repository
    const installationId =
      knownInstallationId ?? (await lookupInstallationId(owner, repo, options));

    // Create an installation access token with 30-day expiry
    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() + 30);

    const { data: tokenData } = await app.octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: installationId,
        repositories: [repo],
        expires_at: expirationDate.toISOString(),
        ...requestSignal(options),
      },
    );

    return tokenData.token;
  } catch (error: unknown) {
    throw notInstalledOr(error, owner, repo);
  }
}

type PermissionLevel = "read" | "write";
type PermissionSet = Readonly<Record<string, PermissionLevel>>;

const PERMISSION_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** True when `granted` is at least `needed` (write covers read). */
function grantsLevel(
  granted: string | undefined,
  needed: PermissionLevel,
): boolean {
  return (PERMISSION_RANK[granted ?? ""] ?? 0) >= PERMISSION_RANK[needed]!;
}

/**
 * A permission the installation does not grant at the level a token needs.
 * The message names the permission, never a token.
 */
export class MissingInstallationPermissionError extends Error {
  constructor(
    readonly permission: string,
    readonly needed: string,
    readonly granted: string | undefined,
  ) {
    super(
      `GitHub App installation lacks the "${permission}" permission (needs ${needed}, granted ${granted ?? "none"})`,
    );
    this.name = "MissingInstallationPermissionError";
  }
}

// In-process cache of the granted permissions (one Worker isolate). Errors are
// never cached and no token is ever logged. The tokens themselves are cached
// by @octokit/auth-app (per App instance: LRU, in-flight de-dup, 59 min TTL).
const GRANTED_PERMISSIONS_TTL_MS = 5 * 60_000;
/** A reused token with less than this left is replaced by a fresh one. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** A token returned for a "fresh" request must have been minted this recently. */
const FRESH_TOKEN_MAX_AGE_MS = 60_000;

const grantedPermissionsCache = new Map<
  string,
  {
    installationId: number;
    permissions: Record<string, string | undefined>;
    cachedAt: number;
  }
>();

/**
 * Test hook: forget every cached permission read, and drop the App instance so
 * @octokit/auth-app's token cache starts empty.
 */
export function clearInstallationTokenCacheForTests(): void {
  grantedPermissionsCache.clear();
  resetAppInstance();
}

async function readGrantedPermissions(owner: string, repo: string) {
  const key = `${owner}/${repo}`.toLowerCase();
  const cached = grantedPermissionsCache.get(key);
  if (cached && Date.now() - cached.cachedAt < GRANTED_PERMISSIONS_TTL_MS) {
    return cached;
  }
  const found = await getRepoInstallationPermissions(owner, repo);
  const entry = { ...found, cachedAt: Date.now() };
  grantedPermissionsCache.set(key, entry);
  return entry;
}

/**
 * The one way an installation token is minted, for exactly one repository.
 *
 * The installation's granted permissions are read ONCE (cached for 5 minutes;
 * the read also yields the installation id). Every `required` permission must
 * be granted at the requested level or more, else
 * MissingInstallationPermissionError; each `optional` permission is added only
 * when granted. If the permissions read FAILS (network, 5xx, rate limit) the
 * mint falls back to the required set alone, without optional permissions, and
 * lets GitHub's own 422 reject a permission the installation truly lacks; a
 * failed read is never cached, and a "not installed" answer still throws. The
 * token comes from @octokit/auth-app
 * (`octokit.auth({ type: "installation", ... })`) for exactly the computed set
 * on `[repo]`, with no `expires_at` (GitHub caps installation tokens at one
 * hour); the response's own expiry is returned. With `cacheToken`, auth-app's
 * cache reuses a token (per installation, repo and permission set) unless it
 * has less than 5 minutes left, in which case one refresh is made; without it
 * every call asks for a fresh token (`refresh: true`).
 * `knownInstallationId` overrides the installation id the read found. `label`
 * names the token in the error for a response without a token or an expiry.
 */
async function mintRepoInstallationToken({
  owner,
  repo,
  required,
  optional = {},
  label,
  cacheToken,
  knownInstallationId,
}: {
  owner: string;
  repo: string;
  required: PermissionSet;
  optional?: PermissionSet;
  label: string;
  cacheToken: boolean;
  knownInstallationId?: number;
}): Promise<{ token: string; expiresAt: string }> {
  let granted: Awaited<ReturnType<typeof readGrantedPermissions>> | null = null;
  try {
    granted = await readGrantedPermissions(owner, repo);
  } catch (error: unknown) {
    if (isNotInstalledError(error)) throw error;
    // Fall back to the required set: no optional permission is guessed.
  }
  const permissions: Record<string, PermissionLevel> = { ...required };
  if (granted) {
    for (const [name, level] of Object.entries(required)) {
      if (!grantsLevel(granted.permissions[name], level)) {
        throw new MissingInstallationPermissionError(
          name,
          level,
          granted.permissions[name],
        );
      }
    }
    for (const [name, level] of Object.entries(optional)) {
      if (grantsLevel(granted.permissions[name], level)) {
        permissions[name] = level;
      }
    }
  }
  const installationId =
    knownInstallationId ??
    granted?.installationId ??
    (await lookupInstallationId(owner, repo));

  const authenticate = (refresh: boolean) =>
    getGitHubApp().octokit.auth({
      type: "installation",
      installationId,
      repositoryNames: [repo],
      permissions,
      refresh,
    } as never) as Promise<{
      token?: unknown;
      expiresAt?: unknown;
      createdAt?: unknown;
    }>;
  let auth: Awaited<ReturnType<typeof authenticate>>;
  try {
    auth = await authenticate(!cacheToken);
    // The cache can hand back a token about to expire; a "fresh" request can
    // join an in-flight cached lookup. One refresh settles both.
    const expiresAtMs = Date.parse(String(auth.expiresAt));
    const createdAtMs = Date.parse(String(auth.createdAt));
    const stale = cacheToken
      ? Number.isFinite(expiresAtMs) &&
        expiresAtMs - Date.now() < TOKEN_REFRESH_MARGIN_MS
      : Number.isFinite(createdAtMs) &&
        Date.now() - createdAtMs > FRESH_TOKEN_MAX_AGE_MS;
    if (stale) auth = await authenticate(true);
  } catch (error: unknown) {
    throw notInstalledOr(error, owner, repo);
  }
  if (typeof auth.token !== "string" || typeof auth.expiresAt !== "string") {
    throw new Error(
      `GitHub App token response has no token or no expires_at (${label})`,
    );
  }
  return { token: auth.token, expiresAt: auth.expiresAt };
}

/**
 * The permissions a read-only task token is minted with (phase 7), all four
 * required. No write and no admin key, by construction.
 */
export const READ_ONLY_TOKEN_PERMISSIONS = {
  contents: "read",
  metadata: "read",
  pull_requests: "read",
  issues: "read",
} as const;

/**
 * A READ-ONLY installation token for exactly one repository (phase 7).
 *
 * Scope: READ_ONLY_TOKEN_PERMISSIONS on `[repo]`, all required: an
 * installation that lacks one throws MissingInstallationPermissionError naming
 * it. Used for task runs whose admin-selected packs require
 * `github-read-token` (BATTERY_PACK_REQUIRES) and by the knowledge readers —
 * never for review runs, which keep the #81/ADR-004 fence (no GitHub
 * credential in the agent at all). Every call mints a FRESH token and never
 * reuses one: the agent run holds the token for the whole task, so a reused
 * token with only minutes left could expire mid-task. (The granted-permissions
 * read is still cached.) See mintRepoInstallationToken for lifetime and
 * `knownInstallationId`.
 */
export async function getReadOnlyInstallationToken(
  owner: string,
  repo: string,
  knownInstallationId?: number,
): Promise<{ token: string; expiresAt: string }> {
  return mintRepoInstallationToken({
    owner,
    repo,
    required: READ_ONLY_TOKEN_PERMISSIONS,
    label: "read-only token",
    cacheToken: false,
    knownInstallationId,
  });
}

/** What the remote-cell broker needs to read: contents and metadata. */
export const CELL_READ_REQUIRED_PERMISSIONS = {
  contents: "read",
  metadata: "read",
} as const;

/** Added to a cell read token only when the installation grants them. */
export const CELL_READ_OPTIONAL_PERMISSIONS = {
  pull_requests: "read",
  issues: "read",
} as const;

/**
 * A read token for the remote-cell broker (#606): git fetches and gh reads.
 * contents and metadata are required; pull requests and issues are included
 * when the installation grants them, so a missing optional one narrows the
 * token instead of failing it. Fetch-side calls only; pushes use
 * getWriteInstallationToken. Tokens are reused (see mintRepoInstallationToken):
 * the broker uses one within a single request.
 */
export async function getCellReadInstallationToken(
  owner: string,
  repo: string,
  knownInstallationId?: number,
): Promise<{ token: string; expiresAt: string }> {
  return mintRepoInstallationToken({
    owner,
    repo,
    required: CELL_READ_REQUIRED_PERMISSIONS,
    optional: CELL_READ_OPTIONAL_PERMISSIONS,
    label: "cell read token",
    cacheToken: true,
    knownInstallationId,
  });
}

/** The permissions every remote-cell write token requires (#606). */
export const WRITE_TOKEN_PERMISSIONS = {
  contents: "write",
  metadata: "read",
} as const;

/** Added to a write token only when the installation grants Workflows write. */
export const WRITE_OPTIONAL_PERMISSIONS = { workflows: "write" } as const;

/**
 * A contents-write installation token for exactly one repository (#606), for
 * the remote-cell broker only: both legs of a push (the info/refs
 * advertisement and the receive-pack POST).
 *
 * contents:write and metadata:read are required; `workflows: write` is
 * included only when the installation grants it (owner decision on #606), so a
 * remote cell can change `.github/workflows/` only then. Otherwise GitHub
 * rejects such a push and the rejection reaches git. See
 * mintRepoInstallationToken for lifetime, caching and `knownInstallationId`.
 */
export async function getWriteInstallationToken(
  owner: string,
  repo: string,
  knownInstallationId?: number,
): Promise<{ token: string; expiresAt: string }> {
  return mintRepoInstallationToken({
    owner,
    repo,
    required: WRITE_TOKEN_PERMISSIONS,
    optional: WRITE_OPTIONAL_PERMISSIONS,
    label: "write token",
    cacheToken: true,
    knownInstallationId,
  });
}

/**
 * The id of the App installation that covers a repository, or null when the
 * App is not installed on it.
 */
export async function getRepoInstallationId(
  owner: string,
  repo: string,
): Promise<number | null> {
  try {
    const { data } = await getGitHubApp().octokit.request(
      "GET /repos/{owner}/{repo}/installation",
      { owner, repo },
    );
    return data.id;
  } catch (error) {
    if ((error as { status?: number } | null)?.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * The installation covering a repository and the permissions it was granted
 * (`GET /repos/{owner}/{repo}/installation`). Feeds the self-heal permission
 * preflight and latch. A 404 throws the "not installed" error.
 */
export async function getRepoInstallationPermissions(
  owner: string,
  repo: string,
  options?: GitHubCallOptions,
): Promise<{
  installationId: number;
  permissions: Record<string, string | undefined>;
}> {
  try {
    const { data } = await getGitHubApp().octokit.request(
      "GET /repos/{owner}/{repo}/installation",
      { owner, repo, ...requestSignal(options) },
    );
    return {
      installationId: data.id,
      permissions: { ...(data.permissions as Record<string, string>) },
    };
  } catch (error: unknown) {
    throw notInstalledOr(error, owner, repo);
  }
}

/**
 * Check if the GitHub App is installed on a repository
 * @param owner Repository owner
 * @param repo Repository name
 * @returns Boolean indicating if app is installed
 */
export async function isAppInstalledOnRepo(
  owner: string,
  repo: string,
): Promise<boolean> {
  const app = getGitHubApp();

  try {
    await app.octokit.request("GET /repos/{owner}/{repo}/installation", {
      owner,
      repo,
    });
    return true;
  } catch (error: any) {
    if (error.status === 404) {
      return false;
    }
    throw error;
  }
}
