/**
 * Verify every self-heal fix PR of a benchmark fixture repo (R6, phase 9).
 *
 * Usage:
 *   pnpm exec tsx deploy/self-heal-bench/verify-fixes.ts \
 *     --repo <owner/repo> --manifest <manifest.json> --hidden <hidden-tests dir> \
 *     --export <collect.ts output> --out <verification.json> [--pnpm <abs path>] [--force]
 *
 * Read-only on GitHub: `gh api` GETs and one `gh repo clone` (fetches only).
 * It clones the fixture repo into a fresh directory under $TMPDIR and, for
 * every PR whose head branch starts with FIX_BRANCH_PREFIX (`automata/fix-`):
 *   1. maps the PR to its seed through the export (attempt pr_number ->
 *      finding -> matchSeed); a PR with no seed is reported with seedId null;
 *   2. checks out the PR head on a clean tree (every refs/pull/<n>/head is
 *      fetched once, right after the clone);
 *   3. runs the seed's hidden test with `node --test`
 *      (BENCH_REPO_ROOT=<checkout>, scrubbed env, 60 s timeout);
 *   4. runs the seed's deterministic check;
 *   5. scans the PR's added lines for suppression markers with the www
 *      suppression guard (hasSuppressionMarker, the regexes production uses);
 *      the PR file listings are read up front, at most 4 at a time, while
 *      the clone runs. Checkouts and tests stay sequential.
 * Then it runs every seed's check on the default branch head in one call
 * (finalChecks, which score.ts uses for the false-closure rate). The clone is
 * deleted on exit, also on failure.
 *
 * The checks ARE the worker's: runSelfHealChecks from packages/worker/src/
 * agent-run/self-heal-checks.ts (its scripts, subject/key validation, audit
 * parsers and outcome mapping), run as the current user (agentUser "") inside
 * the checkout with a scrubbed env. The worker's pnpm is a pinned binary off
 * PATH; here pnpm audits use --pnpm, else the absolute `command -v pnpm`.
 * An inability to run a check is "error", never "pass".
 *
 * CAUTION: hidden tests import PR-head code written by the fix agent. Run
 * this on a disposable machine or container if in doubt; the child env is
 * scrubbed to PATH/HOME/TMPDIR so no token of yours reaches it.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { hasSuppressionMarker } from "../../apps/www/src/server-lib/audit/suppression-guard";
import {
  parseFixtureManifest,
  type Seed,
} from "../../packages/shared/src/self-heal/bench/fixture-manifest";
import { recordOf } from "../../packages/shared/src/self-heal/bench/narrow";
import {
  matchSeed,
  parseExportSnapshot,
  type BenchCheckOutcome,
  type PrVerification,
  type VerificationResult,
} from "../../packages/shared/src/self-heal/bench/score";
import { FIX_BRANCH_PREFIX } from "../../packages/shared/src/self-heal/fix-paths";
import { runAsAgent } from "../../packages/worker/src/agent-run/agent-command";
import { runSelfHealChecks } from "../../packages/worker/src/agent-run/self-heal-checks";
import {
  assertRepo,
  fail,
  parseCli,
  mapLimit,
  refuseOverwrite,
  runMain,
  writeJson,
} from "./cli";

const USAGE =
  "Usage: pnpm exec tsx deploy/self-heal-bench/verify-fixes.ts --repo <owner/repo> --manifest <manifest.json> --hidden <hidden-tests dir> --export <export.json> --out <file> [--pnpm <abs path>] [--force]";
const HIDDEN_TEST_TIMEOUT_MS = 60_000;
const CHECK_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 64 * 1024 * 1024;
const GH_CONCURRENCY = 4;

interface RunResult {
  code: number | null;
  stdout: string;
}

function parseArgs(): {
  repo: string;
  manifest: string;
  hidden: string;
  exportFile: string;
  out: string;
  pnpm: string | undefined;
  force: boolean;
} {
  const { values } = parseCli(
    {
      options: {
        repo: { type: "string" },
        manifest: { type: "string" },
        hidden: { type: "string" },
        export: { type: "string" },
        out: { type: "string" },
        pnpm: { type: "string" },
        force: { type: "boolean", default: false },
      },
    },
    USAGE,
  );
  const { repo, manifest, hidden, out, pnpm, force } = values;
  const exportFile = values.export;
  if (!repo || !manifest || !hidden || !exportFile || !out) fail(USAGE);
  assertRepo(repo);
  if (pnpm !== undefined && !isAbsolute(pnpm)) {
    fail(`--pnpm must be an absolute path, got: ${pnpm}`);
  }
  return { repo, manifest, hidden, exportFile, out, pnpm, force };
}

/** Child processes get no credential of the operator. */
function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    ...extra,
  };
}

function run(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((done) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env ?? scrubbedEnv(),
        timeout: options.timeoutMs,
        maxBuffer: MAX_OUTPUT,
      },
      (error, stdout) => {
        const code =
          error === null
            ? 0
            : typeof error.code === "number" && !error.killed
              ? error.code
              : null;
        done({ code, stdout: String(stdout) });
      },
    );
  });
}

/** gh needs the operator's own auth, so it keeps the full environment. */
async function ghGet(path: string): Promise<unknown> {
  const result = await run("gh", ["api", "--paginate", "--slurp", path], {
    env: process.env,
    timeoutMs: CHECK_TIMEOUT_MS,
  });
  if (result.code !== 0) throw new Error(`gh api GET ${path} failed`);
  const pages: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(pages)) throw new Error(`gh api ${path}: not paginated`);
  return pages.every(Array.isArray) ? pages.flat() : pages[0];
}

async function git(cwd: string, args: string[]): Promise<RunResult> {
  return run("git", args, { cwd, timeoutMs: CHECK_TIMEOUT_MS });
}

/** Every PR head as refs/remotes/pr/<n>, and the default branch, in one fetch. */
async function fetchRefs(cwd: string, defaultBranch: string): Promise<void> {
  const fetched = await git(cwd, [
    "fetch",
    "--quiet",
    "origin",
    "+refs/pull/*/head:refs/remotes/pr/*",
    `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`,
  ]);
  if (fetched.code !== 0) throw new Error("git fetch of the PR heads failed");
}

async function checkoutClean(cwd: string, ref: string): Promise<void> {
  const checkout = await git(cwd, [
    "checkout",
    "--quiet",
    "--detach",
    "--force",
    ref,
  ]);
  if (checkout.code !== 0) throw new Error(`git checkout ${ref} failed`);
  await git(cwd, ["clean", "-ffdxq"]);
}

async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
}

/**
 * The pnpm the audit check runs: --pnpm, else `command -v pnpm` on the
 * scrubbed PATH. "" when there is none: the worker's check then reports
 * pnpm audits as "error" (pnpm absent), never "pass".
 */
async function resolvePnpm(flag: string | undefined): Promise<string> {
  if (flag !== undefined) return flag;
  const found = await run("/bin/sh", ["-c", "command -v pnpm"], {
    timeoutMs: CHECK_TIMEOUT_MS,
  });
  const path = found.stdout.trim();
  if (found.code === 0 && isAbsolute(path)) return path;
  console.error(
    "warning: no pnpm on PATH; pass --pnpm, or pnpm-lock.yaml audits report error",
  );
  return "";
}

/** The worker's checks for these seeds on the checkout, by seed id. */
async function runChecks(
  seeds: readonly Seed[],
  checkout: string,
  pnpmPath: string,
): Promise<Map<string, BenchCheckOutcome>> {
  const checks = seeds.flatMap((seed) =>
    seed.check === null
      ? []
      : [
          {
            fingerprint: seed.id,
            check: seed.check,
            subject: seed.subject,
            ...(seed.key !== undefined && { key: seed.key }),
          },
        ],
  );
  const results = await runSelfHealChecks({
    checks,
    run: runAsAgent,
    agentUser: "",
    workdir: checkout,
    env: scrubbedEnv(),
    pnpmPath,
    perCheckMs: CHECK_TIMEOUT_MS,
    budgetMs: CHECK_TIMEOUT_MS * Math.max(1, checks.length),
    note: (message) => console.error(`note: ${message}`),
  });
  return new Map(results.map((r) => [r.fingerprint, r.outcome]));
}

async function checkSeed(
  seed: Seed | null,
  checkout: string,
  pnpmPath: string,
): Promise<PrVerification["check"]> {
  if (seed === null || seed.check === null) return "skipped";
  return (await runChecks([seed], checkout, pnpmPath)).get(seed.id) ?? "error";
}

async function runHiddenTest(
  seed: Seed | null,
  hiddenDir: string,
  checkout: string,
): Promise<PrVerification["hiddenTest"]> {
  if (seed === null) return "missing";
  const file = join(hiddenDir, seed.hiddenTest.replace(/^hidden-tests\//, ""));
  if (!existsSync(file)) return "missing";
  const result = await run("node", ["--test", file], {
    cwd: checkout,
    env: scrubbedEnv({ BENCH_REPO_ROOT: checkout }),
    timeoutMs: HIDDEN_TEST_TIMEOUT_MS,
  });
  return result.code === 0 ? "pass" : "fail";
}

async function suppressionHits(
  repo: string,
  prNumber: number,
): Promise<string[]> {
  const files = await ghGet(`repos/${repo}/pulls/${prNumber}/files`);
  if (!Array.isArray(files)) throw new Error("PR files is not an array");
  return files
    .map((raw) => recordOf(raw, "PR file"))
    .flatMap((f) =>
      typeof f.filename === "string" &&
      typeof f.patch === "string" &&
      hasSuppressionMarker({ filename: f.filename, patch: f.patch })
        ? [f.filename]
        : [],
    );
}

async function main(): Promise<void> {
  const args = parseArgs();
  refuseOverwrite(args.out, args.force);
  const manifest = parseFixtureManifest(
    JSON.parse(readFileSync(args.manifest, "utf8")),
  );
  const snapshot = parseExportSnapshot(
    JSON.parse(readFileSync(args.exportFile, "utf8")),
  );
  if (snapshot.repoFullName.toLowerCase() !== args.repo.toLowerCase()) {
    fail(`the export is for ${snapshot.repoFullName}, not ${args.repo}`);
  }
  const hiddenDir = resolve(args.hidden);
  const pnpmPath = await resolvePnpm(args.pnpm);
  const findingById = new Map(snapshot.findings.map((f) => [f.id, f]));
  /** The finding of each PR's first attempt. */
  const findingIdByPr = new Map<number, string>();
  for (const attempt of snapshot.attempts) {
    if (attempt.prNumber !== null && !findingIdByPr.has(attempt.prNumber)) {
      findingIdByPr.set(attempt.prNumber, attempt.findingId);
    }
  }
  const seedOfPr = (prNumber: number): Seed | null => {
    const findingId = findingIdByPr.get(prNumber);
    const finding =
      findingId === undefined ? undefined : findingById.get(findingId);
    return finding ? matchSeed(manifest, finding) : null;
  };

  const repoInfo = recordOf(await ghGet(`repos/${args.repo}`), "repo");
  const defaultBranch = repoInfo.default_branch;
  if (typeof defaultBranch !== "string") fail("repo has no default_branch");
  const pulls = await ghGet(`repos/${args.repo}/pulls?state=all&per_page=100`);
  if (!Array.isArray(pulls)) fail("pulls is not an array");
  const fixPrs = pulls
    .map((raw) => recordOf(raw, "pull"))
    .filter((p) => {
      const head = p.head as { ref?: unknown } | undefined;
      return (
        typeof head?.ref === "string" &&
        head.ref.startsWith(FIX_BRANCH_PREFIX) &&
        typeof p.number === "number"
      );
    })
    .map((p) => p.number as number)
    .sort((a, b) => a - b);

  const workDir = mkdtempSync(join(tmpdir(), "bench-verify-"));
  const checkout = join(workDir, "checkout");
  try {
    const clone = async (): Promise<void> => {
      const cloned = await run(
        "gh",
        ["repo", "clone", args.repo, checkout, "--", "--quiet", "--no-tags"],
        { env: process.env, timeoutMs: CHECK_TIMEOUT_MS },
      );
      if (cloned.code !== 0) {
        throw new Error(`gh repo clone ${args.repo} failed`);
      }
      await fetchRefs(checkout, defaultBranch);
    };
    // Settle both before failing, so the clone is never removed mid-write.
    const [listed, cloned] = await Promise.allSettled([
      mapLimit(fixPrs, GH_CONCURRENCY, (prNumber) =>
        suppressionHits(args.repo, prNumber),
      ),
      clone(),
    ]);
    if (cloned.status === "rejected") throw cloned.reason;
    if (listed.status === "rejected") throw listed.reason;
    const hits = listed.value;

    const prs: PrVerification[] = [];
    for (const [index, prNumber] of fixPrs.entries()) {
      const seed = seedOfPr(prNumber);
      await checkoutClean(checkout, `refs/remotes/pr/${prNumber}`);
      const entry: PrVerification = {
        prNumber,
        headSha: await headSha(checkout),
        seedId: seed?.id ?? null,
        hiddenTest: await runHiddenTest(seed, hiddenDir, checkout),
        check: await checkSeed(seed, checkout, pnpmPath),
        suppressionHits: hits[index] ?? [],
      };
      prs.push(entry);
      console.log(
        `PR #${prNumber} seed=${entry.seedId ?? "-"} hidden=${entry.hiddenTest} check=${entry.check} suppressions=${entry.suppressionHits.length}`,
      );
    }

    await checkoutClean(checkout, `refs/remotes/origin/${defaultBranch}`);
    const defaultBranchSha = await headSha(checkout);
    const finalChecks: Record<string, BenchCheckOutcome> = Object.fromEntries(
      await runChecks(manifest.seeds, checkout, pnpmPath),
    );

    const result: VerificationResult = {
      repoFullName: args.repo,
      defaultBranchSha,
      finalChecks,
      prs,
    };
    writeJson(args.out, result);
    const failing = Object.values(finalChecks).filter(
      (o) => o === "fail",
    ).length;
    console.log(
      `verified ${prs.length} fix PRs; ${failing} seeds still fail on ${defaultBranch}@${defaultBranchSha.slice(0, 12)} -> ${args.out}`,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

runMain("verify-fixes", main);
