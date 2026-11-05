import { db } from "@/lib/db";
import {
  getReadOnlyInstallationToken,
  getRepoInstallationId,
} from "@terragon/shared/github-app";
import { getInstallationOrgAndMode } from "@terragon/shared/model/github-installation";
import { assertIntentFields } from "@terragon/shared/model/knowledge-minimize";

/**
 * D-03 / PD-19: read the default-branch head sha of one repository, for the
 * reconcile sweep's head check (the recovery of a swallowed push write).
 *
 * GitHub cost: 3 calls on the normal path (installation lookup, token mint,
 * head) and at most 5 when the stored branch 404s (plus one repository read
 * and one retry). Only the default branch is read (PIPE-03). The org is
 * resolved from the installation id before any read (T-13-65). The read-only
 * installation token lives only in this function and is never logged or
 * returned (T-13-64). Never throws.
 */

const GITHUB_API = "https://api.github.com";
/** Per-request ceiling, combined with the caller's overall deadline signal. */
const REQUEST_TIMEOUT_MS = 3_000;
const HEAD_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const PLACEHOLDER_SHA = "0".repeat(40);

export type DefaultBranchHead =
  | { kind: "ok"; sha: string; defaultBranch: string }
  | {
      kind:
        | "no_access"
        | "installation_mismatch"
        | "empty"
        | "not_found"
        | "error";
    };

export interface ReadDefaultBranchHeadInput {
  organizationId: string;
  /** Lowercased `owner/name`. */
  repoFullName: string;
  /** The cursor's stored branch; null when the repo has no cursor yet. */
  defaultBranch: string | null;
  /** The per-repo overall deadline, owned by the caller. */
  signal: AbortSignal;
}

export interface ReadDefaultBranchHeadDeps {
  getInstallationId(owner: string, repo: string): Promise<number | null>;
  getInstallationOrganizationId(installationId: number): Promise<string | null>;
  mintReadToken(
    owner: string,
    repo: string,
    installationId: number,
  ): Promise<string>;
  fetch: typeof fetch;
}

const defaultDeps: ReadDefaultBranchHeadDeps = {
  getInstallationId: (owner, repo) => getRepoInstallationId(owner, repo),
  getInstallationOrganizationId: async (installationId) =>
    (await getInstallationOrgAndMode({ db, installationId })).organizationId,
  mintReadToken: async (owner, repo, installationId) =>
    (await getReadOnlyInstallationToken(owner, repo, installationId)).token,
  fetch: (input, init) => fetch(input, init),
};

class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

/** Race a promise against the signal: a slow helper cannot hold the sweep. */
async function within<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new AbortedError();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new AbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function isValidBranch(branch: string): boolean {
  try {
    assertIntentFields({
      repoFullName: "o/r",
      defaultBranch: branch,
      targetSha: PLACEHOLDER_SHA,
    });
    return true;
  } catch {
    return false;
  }
}

export async function readDefaultBranchHead(
  input: ReadDefaultBranchHeadInput,
  deps: ReadDefaultBranchHeadDeps = defaultDeps,
): Promise<DefaultBranchHead> {
  try {
    const [owner, name, ...rest] = input.repoFullName.split("/");
    if (!owner || !name || rest.length > 0) return { kind: "error" };
    if (input.defaultBranch !== null && !isValidBranch(input.defaultBranch)) {
      return { kind: "error" };
    }
    const outer = input.signal;

    const installationId = await within(
      deps.getInstallationId(owner, name),
      outer,
    );
    if (installationId === null) return { kind: "no_access" };
    const boundOrg = await within(
      deps.getInstallationOrganizationId(installationId),
      outer,
    );
    if (boundOrg !== input.organizationId) {
      return { kind: "installation_mismatch" };
    }
    const token = await within(
      deps.mintReadToken(owner, name, installationId),
      outer,
    );

    const request = (path: string, accept: string): Promise<Response> => {
      if (outer.aborted) throw new AbortedError();
      const signal = AbortSignal.any([
        outer,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]);
      return deps.fetch(`${GITHUB_API}${path}`, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: accept,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    };
    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const readHead = async (
      branch: string,
    ): Promise<
      { status: "ok"; sha: string } | { status: "404" | "409" | "error" }
    > => {
      const res = await request(
        `${repoPath}/commits/${encodeURIComponent(branch)}`,
        "application/vnd.github.sha",
      );
      if (res.status === 404) return { status: "404" };
      if (res.status === 409) return { status: "409" };
      if (res.status !== 200) return { status: "error" };
      const body = (await res.text()).trim();
      return HEAD_SHA_RE.test(body)
        ? { status: "ok", sha: body }
        : { status: "error" };
    };

    let branch = input.defaultBranch;
    if (branch === null) {
      const fetched = await readRepoDefaultBranch(request, repoPath);
      if (fetched.kind !== "ok") return fetched;
      branch = fetched.defaultBranch;
    }

    let head = await readHead(branch);
    if (head.status === "404" && branch === input.defaultBranch) {
      // The stored branch is gone or renamed: take the repository's current
      // default branch and retry once.
      const fetched = await readRepoDefaultBranch(request, repoPath);
      if (fetched.kind !== "ok") return fetched;
      branch = fetched.defaultBranch;
      head = await readHead(branch);
    }
    if (head.status === "ok") {
      return { kind: "ok", sha: head.sha, defaultBranch: branch };
    }
    if (head.status === "409") return { kind: "empty" };
    if (head.status === "404") return { kind: "not_found" };
    return { kind: "error" };
  } catch {
    // Timeouts, aborts, network and GitHub errors: the next slot retries.
    return { kind: "error" };
  }
}

async function readRepoDefaultBranch(
  request: (path: string, accept: string) => Promise<Response>,
  repoPath: string,
): Promise<
  { kind: "ok"; defaultBranch: string } | { kind: "not_found" | "error" }
> {
  const res = await request(repoPath, "application/vnd.github+json");
  if (res.status === 404) return { kind: "not_found" };
  if (res.status !== 200) return { kind: "error" };
  const body: unknown = await res.json();
  const branch =
    typeof body === "object" && body !== null
      ? (body as { default_branch?: unknown }).default_branch
      : undefined;
  if (typeof branch !== "string" || !isValidBranch(branch)) {
    return { kind: "error" };
  }
  return { kind: "ok", defaultBranch: branch };
}
