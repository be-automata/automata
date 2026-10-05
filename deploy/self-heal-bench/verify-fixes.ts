/**
 * Verify every self-heal fix PR of a benchmark fixture repo (R6, phase 9).
 *
 * Usage:
 *   pnpm exec tsx deploy/self-heal-bench/verify-fixes.ts \
 *     --repo <owner/repo> --manifest <manifest.json> --hidden <hidden-tests dir> \
 *     --export <collect.ts output> --out <verification.json> [--force]
 *
 * Read-only on GitHub: `gh api` GETs and one `gh repo clone` (fetches only).
 * It clones the fixture repo into a fresh directory under $TMPDIR and, for
 * every PR whose head branch starts with `automata/fix-`:
 *   1. maps the PR to its seed through the export (attempt pr_number ->
 *      finding -> matchSeed); a PR with no seed is reported with seedId null;
 *   2. checks out the PR head (refs/pull/<n>/head) on a clean tree;
 *   3. runs the seed's hidden test with `node --test`
 *      (BENCH_REPO_ROOT=<checkout>, scrubbed env, 60 s timeout);
 *   4. runs the seed's deterministic check;
 *   5. scans the PR's added lines for suppression markers with the www
 *      suppression guard (evaluateFixDiff, the same regexes production uses).
 * Then it runs every seed's check on the default branch head (finalChecks,
 * which score.ts uses for the false-closure rate). The clone is deleted on
 * exit, also on failure.
 *
 * The checks reproduce the worker's check kinds (packages/worker/src/
 * agent-run/self-heal-checks.ts) with the same commands, run as the current
 * user inside the checkout:
 *   npm-audit-clean           pnpm-lock.yaml -> `pnpm audit --prod --json`,
 *                             else package-lock.json -> `npm audit --omit=dev --json`
 *                             (parsed with the worker's parsers; reads the
 *                             lockfile only, installs nothing)
 *   workflow-actions-pinned   the worker's workflowActionsPinned (absent file = pass)
 *   workflow-has-permissions  the worker's workflowHasPermissions (absent file = pass)
 *   file-exists               the subject is a regular file
 *   path-untracked            `git ls-files --error-unmatch -- <subject>` (0 = fail, 1 = pass)
 *   gitignore-has-pattern     .gitignore lines include the key literally
 *   gitleaks-clean            `gitleaks detect --no-git --no-banner --redact --source <subject> --exit-code 1`
 * An inability to run a check is "error", never "pass".
 *
 * CAUTION: hidden tests import PR-head code written by the fix agent. Run
 * this on a disposable machine or container if in doubt; the child env is
 * scrubbed to PATH/HOME/TMPDIR so no token of yours reaches it.
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { evaluateFixDiff } from "../../apps/www/src/server-lib/audit/suppression-guard";
import {
  parseFixtureManifest,
  type Seed,
} from "../../packages/shared/src/self-heal/bench/fixture-manifest";
import {
  matchSeed,
  parseExportSnapshot,
  type BenchCheckOutcome,
  type PrVerification,
  type VerificationResult,
} from "../../packages/shared/src/self-heal/bench/score";
import {
  AUDIT_PNPM_ENV,
  isSafeSubject,
  parseNpmAuditJson,
  parsePnpmAuditJson,
  workflowActionsPinned,
  workflowHasPermissions,
} from "../../packages/worker/src/agent-run/self-heal-checks";

const USAGE =
  "Usage: pnpm exec tsx deploy/self-heal-bench/verify-fixes.ts --repo <owner/repo> --manifest <manifest.json> --hidden <hidden-tests dir> --export <export.json> --out <file> [--force]";
const FIX_BRANCH_PREFIX = "automata/fix-";
const HIDDEN_TEST_TIMEOUT_MS = 60_000;
const CHECK_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 64 * 1024 * 1024;

interface Args {
  repo: string;
  manifest: string;
  hidden: string;
  exportFile: string;
  out: string;
  force: boolean;
}

interface RunResult {
  code: number | null;
  stdout: string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const values: Record<string, string> = {};
  let force = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--force") {
      force = true;
      continue;
    }
    const value = argv[i + 1];
    if (
      !["--repo", "--manifest", "--hidden", "--export", "--out"].includes(
        arg,
      ) ||
      value === undefined
    ) {
      fail(`bad argument: ${arg}\n${USAGE}`);
    }
    values[arg.slice(2)] = value;
    i += 1;
  }
  const { repo, manifest, hidden, out } = values;
  const exportFile = values.export;
  if (!repo || !manifest || !hidden || !exportFile || !out) fail(USAGE);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    fail(`--repo must be owner/repo, got: ${repo}`);
  }
  return { repo, manifest, hidden, exportFile, out, force };
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

function recordOf(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} is not an object`);
  }
  return value as Record<string, unknown>;
}

async function git(cwd: string, args: string[]): Promise<RunResult> {
  return run("git", args, { cwd, timeoutMs: CHECK_TIMEOUT_MS });
}

async function checkoutClean(cwd: string, ref: string): Promise<void> {
  const fetched = await git(cwd, ["fetch", "--quiet", "origin", ref]);
  if (fetched.code !== 0) throw new Error(`git fetch ${ref} failed`);
  const checkout = await git(cwd, [
    "checkout",
    "--quiet",
    "--detach",
    "--force",
    "FETCH_HEAD",
  ]);
  if (checkout.code !== 0) throw new Error(`git checkout ${ref} failed`);
  await git(cwd, ["clean", "-ffdxq"]);
}

async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
}

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

async function runCheck(
  seed: Seed,
  checkout: string,
): Promise<BenchCheckOutcome> {
  if (seed.check === null) return "error";
  if (seed.check === "npm-audit-clean") {
    const name = seed.subject.slice("npm:".length);
    const pnpm = existsSync(join(checkout, "pnpm-lock.yaml"));
    if (!pnpm && !existsSync(join(checkout, "package-lock.json"))) {
      return "error";
    }
    const result = pnpm
      ? await run("pnpm", ["audit", "--prod", "--json"], {
          cwd: checkout,
          env: scrubbedEnv({ ...AUDIT_PNPM_ENV }),
          timeoutMs: CHECK_TIMEOUT_MS,
        })
      : await run("npm", ["audit", "--omit=dev", "--json"], {
          cwd: checkout,
          timeoutMs: CHECK_TIMEOUT_MS,
        });
    if (result.code === null) return "error";
    try {
      const names = pnpm
        ? parsePnpmAuditJson(result.stdout)
        : parseNpmAuditJson(result.stdout);
      return names.has(name) ? "fail" : "pass";
    } catch {
      return "error";
    }
  }
  if (!isSafeSubject(seed.subject)) return "error";
  const path = join(checkout, seed.subject);
  switch (seed.check) {
    case "workflow-actions-pinned": {
      const text = readText(path);
      return text === null || workflowActionsPinned(text, seed.key)
        ? "pass"
        : "fail";
    }
    case "workflow-has-permissions": {
      const text = readText(path);
      return text === null || workflowHasPermissions(text) ? "pass" : "fail";
    }
    case "file-exists":
      return existsSync(path) && statSync(path).isFile() ? "pass" : "fail";
    case "gitignore-has-pattern": {
      if (seed.key === undefined) return "error";
      const text = readText(path);
      if (text === null) return "fail";
      return text
        .split("\n")
        .map((line) => line.trim())
        .includes(seed.key)
        ? "pass"
        : "fail";
    }
    case "path-untracked": {
      const result = await git(checkout, [
        "ls-files",
        "--error-unmatch",
        "--",
        seed.subject,
      ]);
      return result.code === 0 ? "fail" : result.code === 1 ? "pass" : "error";
    }
    case "gitleaks-clean": {
      const result = await run(
        "gitleaks",
        [
          "detect",
          "--no-git",
          "--no-banner",
          "--redact",
          "--source",
          seed.subject,
          "--exit-code",
          "1",
        ],
        { cwd: checkout, timeoutMs: CHECK_TIMEOUT_MS },
      );
      return result.code === 0 ? "pass" : result.code === 1 ? "fail" : "error";
    }
    default:
      return "error";
  }
}

async function runHiddenTest(
  seed: Seed,
  hiddenDir: string,
  checkout: string,
): Promise<PrVerification["hiddenTest"]> {
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
  seed: Seed | null,
): Promise<string[]> {
  const files = await ghGet(`repos/${repo}/pulls/${prNumber}/files`);
  if (!Array.isArray(files)) throw new Error("PR files is not an array");
  const hits: string[] = [];
  for (const raw of files) {
    const f = recordOf(raw, "PR file");
    if (typeof f.filename !== "string" || typeof f.patch !== "string") {
      continue;
    }
    const verdict = evaluateFixDiff({
      files: [
        {
          filename: f.filename,
          status: typeof f.status === "string" ? f.status : "modified",
          additions: typeof f.additions === "number" ? f.additions : 0,
          deletions: typeof f.deletions === "number" ? f.deletions : 0,
          patch: f.patch,
        },
      ],
      planFiles: null,
      ruleId: seed?.rule ?? "dep.vulnerable",
      subject: seed?.subject ?? null,
      maxDiffLines: Number.MAX_SAFE_INTEGER,
    });
    if (verdict.rejections.includes("suppression_comment")) {
      hits.push(f.filename);
    }
  }
  return hits;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (existsSync(args.out) && !args.force) {
    fail(`refusing to overwrite ${args.out} (pass --force)`);
  }
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
  const findingById = new Map(snapshot.findings.map((f) => [f.id, f]));
  const seedOfPr = (prNumber: number): Seed | null => {
    const attempt = snapshot.attempts.find((a) => a.prNumber === prNumber);
    const finding = attempt ? findingById.get(attempt.findingId) : undefined;
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
    const cloned = await run(
      "gh",
      ["repo", "clone", args.repo, checkout, "--", "--quiet", "--no-tags"],
      { env: process.env, timeoutMs: CHECK_TIMEOUT_MS },
    );
    if (cloned.code !== 0) throw new Error(`gh repo clone ${args.repo} failed`);

    const prs: PrVerification[] = [];
    for (const prNumber of fixPrs) {
      const seed = seedOfPr(prNumber);
      await checkoutClean(checkout, `refs/pull/${prNumber}/head`);
      const entry: PrVerification = {
        prNumber,
        headSha: await headSha(checkout),
        seedId: seed?.id ?? null,
        hiddenTest: seed
          ? await runHiddenTest(seed, hiddenDir, checkout)
          : "missing",
        check:
          seed && seed.check !== null
            ? await runCheck(seed, checkout)
            : "skipped",
        suppressionHits: await suppressionHits(args.repo, prNumber, seed),
      };
      prs.push(entry);
      console.log(
        `PR #${prNumber} seed=${entry.seedId ?? "-"} hidden=${entry.hiddenTest} check=${entry.check} suppressions=${entry.suppressionHits.length}`,
      );
    }

    await checkoutClean(checkout, `refs/heads/${defaultBranch}`);
    const defaultBranchSha = await headSha(checkout);
    const finalChecks: Record<string, BenchCheckOutcome> = {};
    for (const seed of manifest.seeds) {
      if (seed.check !== null) {
        finalChecks[seed.id] = await runCheck(seed, checkout);
      }
    }

    const result: VerificationResult = {
      repoFullName: args.repo,
      defaultBranchSha,
      finalChecks,
      prs,
    };
    writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
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

main().catch((error: unknown) => {
  fail(
    `verify-fixes failed: ${error instanceof Error ? error.message : String(error)}`,
  );
});
