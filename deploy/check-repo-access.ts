/**
 * Operator check: does the GitHub App installation on a repo grant read plus
 * write for doc PRs (metadata:read, contents:write, pull_requests:write)?
 *
 * Usage:
 *   GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY=... \
 *     pnpm exec tsx deploy/check-repo-access.ts <owner/repo> [<owner/repo>...]
 *
 * Example:
 *   ... deploy/check-repo-access.ts example-org/docs
 *
 * One line per repo:
 *   <owner/repo> installation=<id> metadata=<lvl> contents=<lvl> pull_requests=<lvl> verdict=OK|SHORT missing=<list>
 *   <owner/repo> verdict=NOT_INSTALLED
 * Exits 1 if any repo is SHORT or NOT_INSTALLED.
 *
 * SECURITY: GITHUB_APP_PRIVATE_KEY is an operator secret. Never echo it, never
 * commit it, run this only where the operator already holds it. The script
 * prints ids and permission levels only: no tokens, no repo contents.
 */
import { assessRepoAccess, parseRepoArg } from "./repo-access.ts";

const USAGE =
  "Usage: GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY=... pnpm exec tsx deploy/check-repo-access.ts <owner/repo> [<owner/repo>...]";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (
    !process.env.GITHUB_APP_ID ||
    !process.env.GITHUB_APP_PRIVATE_KEY ||
    args.length === 0
  ) {
    console.error(USAGE);
    return 1;
  }

  // Loaded lazily: github-app pulls in ESM-only octokit packages, which a
  // CJS tsx entry can only reach through a dynamic import().
  const { getRepoInstallationPermissions } = await import(
    "../packages/shared/src/github-app"
  );

  let failed = false;
  for (const arg of args) {
    const { owner, repo } = parseRepoArg(arg);
    const name = `${owner}/${repo}`;
    try {
      const { installationId, permissions } =
        await getRepoInstallationPermissions(owner, repo);
      const assessment = assessRepoAccess(permissions);
      if (!assessment.ok) failed = true;
      console.log(
        `${name} installation=${installationId} metadata=${permissions["metadata"] ?? "none"} contents=${permissions["contents"] ?? "none"} pull_requests=${permissions["pull_requests"] ?? "none"} verdict=${assessment.ok ? "OK" : "SHORT"} missing=${assessment.missing.join(",") || "-"}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not installed/i.test(message)) {
        console.log(`${name} verdict=NOT_INSTALLED`);
        failed = true;
      } else {
        throw error;
      }
    }
  }
  return failed ? 1 : 0;
}

async function run(): Promise<void> {
  try {
    process.exit(await main());
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void run();
