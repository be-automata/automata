/**
 * Re-home one GitHub owner's repos from one organization to another
 * (operator tool).
 *
 * Moves every org-stamped row that belongs to a repo whose full name starts
 * with `<owner>/` (case-insensitive) from org `--from` to org `--to`: threads
 * and their chats / visibility / egress audit / self-heal slot, automations,
 * environments, review settings, skills, hatchet runs, the self-heal audit
 * ledger, and the supersede `pr_key` rows (`${orgId}/...` prefix rewritten).
 * Org-scoped state — membership, billing, usage, credentials, installations,
 * org settings, breakers — is NOT moved. The table lists, and the test that
 * keeps them complete, live in packages/shared/src/model/rehome-repos-to-org.ts.
 *
 * Usage (DATABASE_URL must point at the target Postgres):
 *   DATABASE_URL=postgres://... pnpm exec tsx deploy/rehome-repos-to-org.ts \
 *     --owner <github-owner> --from <org-slug> --to <org-slug> \
 *     [--apply] [--on-collision=abort|keep-target]
 *
 * RUNBOOK
 *   1. Dry run first (the default). It does the full move inside a
 *      SERIALIZABLE transaction and ROLLS BACK, printing per-table candidate,
 *      collision, deleted and moved counts. Nothing is written.
 *   2. Take a Neon snapshot (branch) of production before --apply.
 *   3. Re-run with --apply. Same work, COMMITTED. A second --apply moves 0.
 *   4. Rebind the GitHub App installation to the new org — this tool never
 *      touches github_installation:
 *        pnpm exec tsx deploy/bind-github-installation.ts <installationId> <to-slug> [shadow|active]
 *   5. Re-mint CLI tokens: API keys are org-scoped and stay with --from, so
 *      users who drive these repos from the CLI run `terry auth` again with
 *      the new org active.
 *
 * Collisions on the target org's unique keys (environment, repo_review_settings,
 * repo_skills, audit_findings, supersede pr_key rows): `--on-collision=abort`
 * (default) lists the colliding source ids and writes nothing;
 * `--on-collision=keep-target` deletes the SOURCE row (ids are logged; its FK
 * cascades follow, e.g. a dropped skill's versions) and keeps the target's.
 *
 * Refuses (writes nothing) while any hatchet_run for those repos in --from is
 * still in flight (status 'in_flight' AND its thread is not terminal).
 *
 * Exit codes: 0 dry run / applied; 1 usage or database error (fail closed);
 * 2 refused on collisions (abort policy); 3 refused on in-flight runs.
 * The LAST line of output is a machine-readable JSON summary.
 */
import { createDb } from "../packages/shared/src/db";
import {
  formatRehomeTable,
  rehomeReposToOrg,
  RehomeUsageError,
  type RehomeCollisionPolicy,
  type RehomeResult,
} from "../packages/shared/src/model/rehome-repos-to-org";

const USAGE =
  "Usage: DATABASE_URL=... pnpm exec tsx deploy/rehome-repos-to-org.ts " +
  "--owner <github-owner> --from <org-slug> --to <org-slug> " +
  "[--apply] [--on-collision=abort|keep-target]";

interface CliArgs {
  owner: string;
  from: string;
  to: string;
  apply: boolean;
  onCollision: RehomeCollisionPolicy;
}

function fail(message: string): never {
  console.error(message);
  console.log(JSON.stringify({ status: "error", error: message }));
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  const values: Record<string, string> = {};
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    const match = /^--(owner|from|to|on-collision)(?:=(.*))?$/.exec(arg);
    if (!match) fail(`Unknown argument: ${arg}\n${USAGE}`);
    const value = match[2] ?? argv[++i];
    if (value === undefined || value === "") {
      fail(`--${match[1]} needs a value\n${USAGE}`);
    }
    values[match[1]!] = value;
  }
  const { owner, from, to } = values;
  if (!owner || !from || !to) fail(USAGE);
  const onCollision = values["on-collision"] ?? "abort";
  if (onCollision !== "abort" && onCollision !== "keep-target") {
    fail(
      `--on-collision must be 'abort' or 'keep-target', got: ${onCollision}`,
    );
  }
  return { owner, from, to, apply, onCollision };
}

function exitCodeFor(result: RehomeResult): number {
  switch (result.status) {
    case "dry-run":
    case "applied":
      return 0;
    case "refused-collision":
      return 2;
    case "refused-in-flight":
      return 3;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail(`DATABASE_URL is not set.\n${USAGE}`);
  const db = createDb(databaseUrl);

  const result = await rehomeReposToOrg({
    db,
    owner: args.owner,
    fromSlug: args.from,
    toSlug: args.to,
    apply: args.apply,
    onCollision: args.onCollision,
  });

  console.log(
    `rehome ${result.owner}/* : ${result.from.slug} (${result.from.id}) -> ${result.to.slug} (${result.to.id})  [${result.status}, on-collision=${result.onCollision}]\n`,
  );
  console.log(formatRehomeTable(result));

  if (result.inFlight.length > 0) {
    console.log("\nREFUSED: hatchet runs still in flight for these repos:");
    for (const run of result.inFlight) {
      console.log(
        `  ${run.id}  external=${run.externalId}  ${run.repoFullName}#${run.prNumber}`,
      );
    }
    console.log("Wait for them to finish (or cancel them) and re-run.");
  }
  if (result.collisions.length > 0) {
    const verb =
      result.onCollision === "keep-target"
        ? "deleted source row (target kept)"
        : "collides";
    console.log(`\nCollisions on the target org's unique keys:`);
    for (const c of result.collisions) {
      console.log(`  ${c.table}  ${c.sourceId}  (${c.index})  ${verb}`);
    }
    if (result.status === "refused-collision") {
      console.log(
        "Nothing written. Resolve them, or re-run with --on-collision=keep-target.",
      );
    }
  }
  if (result.status === "dry-run") {
    console.log(
      "\nDRY RUN: rolled back, nothing written. Take a Neon snapshot, then re-run with --apply.",
    );
  }
  if (result.status === "applied") {
    console.log(
      `\nAPPLIED. Now rebind the GitHub installation to '${result.to.slug}':\n` +
        `  pnpm exec tsx deploy/bind-github-installation.ts <installationId> ${result.to.slug} [shadow|active]\n` +
        "and have CLI users re-mint their tokens (`terry auth`) with the new org active.",
    );
  }
  console.log(JSON.stringify(result));
  // createDb's pool keeps the event loop alive (see assert-schema-ready.ts).
  process.exit(exitCodeFor(result));
}

main().catch((error: unknown) => {
  const message =
    error instanceof RehomeUsageError
      ? error.message
      : `rehome failed (nothing committed): ${error instanceof Error ? error.message : String(error)}`;
  fail(message);
});
