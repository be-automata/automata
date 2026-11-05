/**
 * Bind one repo to an org inside a shared GitHub App installation (operator tool).
 *
 * One GitHub account can host repos that belong to different orgs, e.g. an
 * agency account that also hosts a client org's repos. The installation binds
 * to ONE org (deploy/bind-github-installation.ts); this writes a per-repo
 * override (github_repo_org_binding) so that repo's installation-resolved
 * events (mentions, mirror intake, merged-PR audits) go to its own org. No row
 * means the installation's org, exactly as before. The mode (shadow/active)
 * still comes from the installation.
 *
 * Dry run by default: prints what it would do and writes nothing.
 *
 * Usage (DATABASE_URL must point at the target Postgres):
 *   DATABASE_URL=postgres://... pnpm exec tsx deploy/bind-repo-to-org.ts \
 *     <owner/repo> <orgSlug> [--apply]
 *   DATABASE_URL=postgres://... pnpm exec tsx deploy/bind-repo-to-org.ts \
 *     <owner/repo> --remove [--apply]
 *
 * Exit codes: 0 dry run / applied; 1 usage, unknown org or database error.
 */
import { createDb } from "../packages/shared/src/db";
import { getOrganizationBySlug } from "../packages/shared/src/model/organizations";
import {
  bindRepoToOrg,
  getRepoOrgBinding,
  unbindRepoFromOrg,
} from "../packages/shared/src/model/github-installation";

const USAGE =
  "Usage: DATABASE_URL=... pnpm exec tsx deploy/bind-repo-to-org.ts <owner/repo> <orgSlug> [--apply]\n" +
  "       DATABASE_URL=... pnpm exec tsx deploy/bind-repo-to-org.ts <owner/repo> --remove [--apply]";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const remove = args.includes("--remove");
const positional = args.filter((a) => !a.startsWith("--"));
const unknownFlags = args.filter(
  (a) => a.startsWith("--") && a !== "--apply" && a !== "--remove",
);
if (unknownFlags.length > 0) {
  fail(`Unknown flag(s): ${unknownFlags.join(", ")}\n${USAGE}`);
}
const [repoArg, orgSlug] = positional;
if (!repoArg || !/^[^/\s]+\/[^/\s]+$/.test(repoArg)) {
  fail(USAGE);
}
if (remove ? orgSlug !== undefined : orgSlug === undefined) {
  fail(USAGE);
}
const repoFullName: string = repoArg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  fail(`DATABASE_URL is not set.\n${USAGE}`);
}

const db = createDb(databaseUrl);

async function main(): Promise<void> {
  const current = await getRepoOrgBinding({ db, repoFullName });
  console.log(
    `${repoFullName}: currently ${
      current
        ? `bound to org ${current.organizationId}`
        : "unbound (routes to the installation's org)"
    }`,
  );

  if (remove) {
    if (!current) {
      console.log("Nothing to remove.");
      return;
    }
    if (!apply) {
      console.log("Dry run: would remove the binding. Re-run with --apply.");
      return;
    }
    await unbindRepoFromOrg({ db, repoFullName });
    console.log("Removed: the repo routes to the installation's org again.");
    return;
  }

  const org = await getOrganizationBySlug({ db, slug: orgSlug ?? "" });
  if (!org) {
    fail(`No organization found with slug '${orgSlug}'. Create the org first.`);
  }
  if (!apply) {
    console.log(
      `Dry run: would bind ${repoFullName} -> org '${org.name}' (${org.id}). Re-run with --apply.`,
    );
    return;
  }
  const bound = await bindRepoToOrg({
    db,
    repoFullName,
    organizationId: org.id,
  });
  console.log(
    `Bound ${bound.repoFullName} -> org '${org.name}' (${org.id}). Mode still follows the installation.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(
      "Bind failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
