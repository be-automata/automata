/**
 * Parse + fetch a PINNED git skill pack (#54 H2 / issue #64). A skill pack is
 * `owner/repo@<40-hex-sha>:<path>` — a body imported from another repo at an
 * EXACT commit, never a branch. The pin is the whole point: a branch name would
 * let the upstream silently change what a skill resolves to on the next run,
 * defeating the content-sha traceability the skill store guarantees.
 */

export type GitPackRef = {
  owner: string;
  repo: string;
  /** Lowercased 40-hex commit sha. */
  sha: string;
  /** Repo-relative path to the skill markdown. */
  path: string;
  /** Canonical `owner/repo@sha:path` — stored as repo_skill_versions.source_ref. */
  canonical: string;
};

/**
 * Parse `owner/repo@<40-hex-sha>:<path>`. Throws with an operator-facing message
 * on any deviation — a branch name, short sha, or missing path must fail here,
 * loudly, not resolve to something unexpected at import time.
 */
export function parseGitPackRef(input: string): GitPackRef {
  const at = input.indexOf("@");
  if (at < 0) {
    throw new Error(
      `git pack ref must be 'owner/repo@<40-hex-sha>:<path>', got: ${input}`,
    );
  }
  const repoPart = input.slice(0, at);
  const rest = input.slice(at + 1);
  const colon = rest.indexOf(":");
  if (colon < 0) {
    throw new Error(
      `git pack ref is missing ':<path>' after the sha: ${input}`,
    );
  }
  const sha = rest.slice(0, colon).toLowerCase();
  const path = rest.slice(colon + 1);

  const repoMatch = repoPart.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!repoMatch) {
    throw new Error(`git pack repo must be 'owner/repo', got: ${repoPart}`);
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(
      `git pack ref must pin a FULL 40-hex commit sha (a branch or short sha ` +
        `is rejected — pins keep the imported body immutable), got: ${sha}`,
    );
  }
  if (path.trim().length === 0) {
    throw new Error(`git pack ref has an empty path: ${input}`);
  }

  return {
    owner: repoMatch[1]!,
    repo: repoMatch[2]!,
    sha,
    path,
    canonical: `${repoMatch[1]}/${repoMatch[2]}@${sha}:${path}`,
  };
}

/**
 * Fetch the raw file bytes for a parsed pack ref via the GitHub contents API at
 * the pinned sha. Uses `GITHUB_TOKEN` when set (required for private source
 * repos; public repos work unauthenticated). Network — not unit-tested; the
 * pure parser above carries the logic worth pinning.
 */
export async function fetchGitPackBody(
  ref: GitPackRef,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  // Encode EVERY interpolated segment. A raw `#`/`?` in the path would
  // otherwise absorb the `?ref=<sha>` suffix into the URL's fragment/query and
  // silently resolve against the DEFAULT branch — the exact pin-defeating
  // "unexpected resolution" this module exists to prevent. Path slashes are
  // separators, so encode per-segment and rejoin.
  const encPath = ref.path.split("/").map(encodeURIComponent).join("/");
  const url =
    `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/` +
    `${encodeURIComponent(ref.repo)}/contents/${encPath}?ref=${ref.sha}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw+json",
    "User-Agent": "automata-skill-push",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    throw new Error(
      `GitHub contents fetch failed (${res.status}) for ${ref.canonical}` +
        (res.status === 404
          ? " — check the path, the sha exists on that repo, and (private repos) GITHUB_TOKEN is set."
          : ""),
    );
  }
  return res.text();
}
