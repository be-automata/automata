/**
 * Replay a PR the legacy orchestrator already reviewed through a ported review
 * skill, before that repo is cut over (operator tool; reads only).
 *
 * Two steps, around one agent run the operator starts by hand:
 *
 *   1. prompt — build the EXACT prompt the platform would send for that PR as
 *      it stood when the legacy review was posted:
 *        pnpm exec tsx deploy/review-replay.ts prompt <owner/repo> <pr> \
 *          --skill-file <flattened.md> --as-of <iso> --event synchronize \
 *          --tolerance info --out prompt.md
 *      (`--skill-file` is skill-push's `--dry-run --out` output.)
 *
 *   2. run the agent in a local checkout at the reviewed sha:
 *        git -C <clone> worktree add /tmp/replay-<pr> <sha>
 *        git -C /tmp/replay-<pr> fetch origin <base>
 *        claude -p --model opus --allowedTools "Read Grep Glob Bash" \
 *          --disallowedTools "Bash(gh:*) Bash(git push:*) WebFetch WebSearch Write Edit" \
 *          < prompt.md > out.txt
 *
 *   3. compare — the agent's verdict after the SAME verify-before-block and
 *      floor the terminal writer applies, next to the legacy review:
 *        pnpm exec tsx deploy/review-replay.ts compare <owner/repo> <pr> \
 *          --legacy-review-id <id> --intent out.txt --worktree /tmp/replay-<pr> \
 *          --tolerance info [--draft]
 *
 * GitHub is read with the operator's own `gh` login. Nothing is written to
 * GitHub or to any database. Choose fixtures from open or squash-merged PRs:
 * `compare` refuses a fixture whose replayed diff is empty (a merge-commit PR
 * whose head is now an ancestor of its base), and prints the replayed file
 * count so it can be checked against the legacy review.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import {
  prViewFromRest,
  renderPrView,
  renderReviewContext,
  type RestPullRequestLike,
} from "../packages/review/src/review/context/render";
import {
  applyApproveSeverityFloor,
  isBlockTolerance,
  isBlockingUnderPolicy,
  toleranceToPolicy,
  type BlockTolerance,
} from "../packages/review/src/review/severity-policy";
import { applyVerifyBeforeBlock } from "../packages/review/src/review/verify-before-block";
import type { FileAtCommit } from "../packages/review/src/review/finding-verifier";
import {
  parseReviewIntent,
  toExecutorIntent,
} from "../apps/www/src/server-lib/review/parse-review-intent";
import {
  buildReplayPrompt,
  legacyVerdict,
  renderHistoricalBlocks,
  resolvedTally,
  type ReplayReview,
  type ReplayThread,
} from "./lib/review-replay-core";

const BOT_LOGIN = "automata-ai-bot[bot]";
const EVENTS = ["opened", "synchronize", "ready_for_review"] as const;
type ReplayEvent = (typeof EVENTS)[number];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function gh(args: string[]): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseFlags(argv: string[]): {
  positional: string[];
  flags: Map<string, string | true>;
} {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const next = argv[i + 1];
    if (arg === "--draft") {
      flags.set(arg, true);
    } else if (next === undefined || next.startsWith("--")) {
      fail(`${arg} needs a value`);
    } else {
      flags.set(arg, next);
      i++;
    }
  }
  return { positional, flags };
}

function requireFlag(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string") fail(`missing ${name}`);
  return value;
}

function assertKnownFlags(
  flags: Map<string, string | true>,
  known: readonly string[],
): void {
  for (const name of flags.keys()) {
    if (!known.includes(name)) fail(`unknown flag ${name}`);
  }
}

function toleranceFrom(flags: Map<string, string | true>): BlockTolerance {
  const raw = requireFlag(flags, "--tolerance");
  if (!isBlockTolerance(raw)) fail(`--tolerance must be info|warning|error`);
  return raw;
}

const THREADS_QUERY = `query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    reviewThreads(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { isResolved path line comments(first: 100) {
        nodes { databaseId author { login } body createdAt } } } } } } }`;

function fetchThreads(repoFullName: string, prNumber: number): ReplayThread[] {
  const [owner, repo] = repoFullName.split("/");
  const threads: ReplayThread[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${THREADS_QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repo}`,
      "-F",
      `number=${prNumber}`,
    ];
    if (cursor) args.push("-F", `cursor=${cursor}`);
    const result = JSON.parse(gh(args)) as {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: Array<{
                isResolved: boolean;
                path: string | null;
                line: number | null;
                comments: { nodes: ReplayThread["comments"] };
              }>;
            };
          };
        };
      };
    };
    const connection = result.data.repository.pullRequest.reviewThreads;
    for (const node of connection.nodes) {
      threads.push({
        isResolved: node.isResolved,
        path: node.path,
        line: node.line,
        comments: node.comments.nodes,
      });
    }
    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }
  return threads;
}

function fetchReviews(repoFullName: string, prNumber: number): ReplayReview[] {
  return gh([
    "api",
    "--paginate",
    `repos/${repoFullName}/pulls/${prNumber}/reviews`,
    "--jq",
    ".[] | tojson",
  ])
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ReplayReview);
}

function runPrompt(argv: string[]): void {
  const { positional, flags } = parseFlags(argv);
  assertKnownFlags(flags, [
    "--skill-file",
    "--as-of",
    "--event",
    "--tolerance",
    "--out",
  ]);
  const [repoFullName, prArg] = positional;
  if (!repoFullName || !prArg) fail("usage: prompt <owner/repo> <pr> …");
  const prNumber = Number(prArg);
  const asOf = requireFlag(flags, "--as-of");
  const event = requireFlag(flags, "--event");
  if (!(EVENTS as readonly string[]).includes(event)) {
    fail(`--event must be one of ${EVENTS.join(", ")}`);
  }
  const tolerance = toleranceFrom(flags);
  const skill = readFileSync(requireFlag(flags, "--skill-file"), "utf8");
  const out = requireFlag(flags, "--out");

  const pr = JSON.parse(
    gh(["api", `repos/${repoFullName}/pulls/${prNumber}`]),
  ) as RestPullRequestLike;
  const { priorReviews, reviewThreads } = renderHistoricalBlocks({
    reviews: fetchReviews(repoFullName, prNumber),
    threads: fetchThreads(repoFullName, prNumber),
    asOf,
    botLogin: BOT_LOGIN,
  });
  const renderedContext = renderReviewContext([
    // Documented limitation: the PR view (title, body, draft flag, counts) is
    // today's, not as of the legacy review; reviews and threads are as of it.
    { name: "pr-view", content: renderPrView(prViewFromRest(pr)) },
    { name: "prior-reviews", content: priorReviews },
    { name: "review-threads", content: reviewThreads },
  ]);
  const prompt = buildReplayPrompt({
    flattenedSkill: skill,
    repoFullName,
    baseRef: pr.base.ref,
    prNumber,
    event: event as ReplayEvent,
    renderedContext,
    tolerance,
  });
  writeFileSync(out, prompt);
  console.log(
    `Wrote ${prompt.length} chars to ${out} (as of ${asOf}; base ${pr.base.ref}).`,
  );
}

async function runCompare(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  assertKnownFlags(flags, [
    "--legacy-review-id",
    "--intent",
    "--worktree",
    "--tolerance",
    "--draft",
  ]);
  const [repoFullName, prArg] = positional;
  if (!repoFullName || !prArg) fail("usage: compare <owner/repo> <pr> …");
  const prNumber = Number(prArg);
  const reviewId = requireFlag(flags, "--legacy-review-id");
  const worktree = requireFlag(flags, "--worktree");
  const policy = toleranceToPolicy(toleranceFrom(flags));
  const isDraft = flags.get("--draft") === true;

  const legacy = JSON.parse(
    gh(["api", `repos/${repoFullName}/pulls/${prNumber}/reviews/${reviewId}`]),
  ) as ReplayReview;
  const parsed = parseReviewIntent(
    readFileSync(requireFlag(flags, "--intent"), "utf8"),
  );
  if (!parsed.ok) {
    console.log(
      `replay: NO VERDICT (${parsed.source}: ${parsed.reason}) — legacy: ${legacy.state}`,
    );
    process.exit(2);
  }
  const intent = parsed.intent;
  const readFile = async (path: string): Promise<FileAtCommit> => {
    try {
      return {
        kind: "content",
        text: execFileSync(
          "git",
          ["-C", worktree, "show", `${intent.commit}:${path}`],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          },
        ),
      };
    } catch {
      return { kind: "missing" };
    }
  };
  const base = (
    JSON.parse(
      gh(["api", `repos/${repoFullName}/pulls/${prNumber}`]),
    ) as RestPullRequestLike
  ).base.ref;
  const changed = execFileSync(
    "git",
    [
      "-C",
      worktree,
      "diff",
      "--name-only",
      `origin/${base}...${intent.commit}`,
    ],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter((line) => line.length > 0);
  if (changed.length === 0) {
    fail(
      `The replayed diff origin/${base}...${intent.commit.slice(0, 8)} is empty — ` +
        "a merge-commit PR whose head is now in its base. Pick another fixture.",
    );
  }
  const verified = await applyVerifyBeforeBlock(toExecutorIntent(intent), {
    policy,
    readFile,
    repo: repoFullName,
    prNumber,
  });
  const final = applyApproveSeverityFloor(verified, policy, { isDraft });
  const gating = (final.comments ?? []).filter(
    (c) => !c.suppressGating && isBlockingUnderPolicy(c.severity, policy),
  ).length;
  const legacyV = legacyVerdict(legacy.state);
  const rows = [
    ["", "legacy", "replay"],
    [
      "review / commit",
      `${reviewId} @ ${(legacy.commit_id ?? "?").slice(0, 8)}`,
      intent.commit.slice(0, 8),
    ],
    [
      "verdict",
      legacyV ?? `${legacy.state} (original unknown)`,
      `${intent.verdict} → ${final.verdict}`,
    ],
    [
      "Resolved X/Y",
      resolvedTally(legacy.body ?? "") ?? "-",
      resolvedTally(intent.summary) ?? "-",
    ],
    ["gating findings", "-", String(gating)],
    ["resolvedThreads", "-", String(intent.resolvedThreads?.length ?? 0)],
  ];
  for (const row of rows) console.log(row.map((c) => c.padEnd(28)).join(""));
  if (legacyV === null) {
    console.log("MATCH: n/a — pick a review that is not DISMISSED");
    process.exit(3);
  }
  console.log(`replayed diff: ${changed.length} files`);
  console.log(`MATCH: ${legacyV === final.verdict ? "yes" : "NO"}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "prompt") runPrompt(rest);
  else if (command === "compare") await runCompare(rest);
  else fail("usage: review-replay.ts prompt|compare <owner/repo> <pr> …");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
