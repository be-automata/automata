/**
 * Bind a GitHub App installation to an org (Somnio pilot / operator tool).
 *
 * This is the registration seam for GitHub mentions (WI-5): the webhook's
 * installation id resolves to an org, and its `mode` decides whether the
 * platform acts on PRs (`active`) or merely ingests them for observation
 * (`shadow`, the safe onboarding default). A NEW binding defaults to `shadow`;
 * pass `active` explicitly to flip an org live once it's verified.
 *
 * Idempotent: re-running upserts on the unique installation id. A rebind that
 * omits `mode` leaves the existing mode untouched (so a metadata refresh never
 * silently reverts an org from active back to shadow).
 *
 * Usage (DATABASE_URL must point at the target Postgres):
 *   DATABASE_URL=postgres://... pnpm exec tsx deploy/bind-github-installation.ts \
 *     <installationId> <orgSlug> [shadow|active]
 *
 * Example — onboard Somnio in shadow, then later flip to active:
 *   ... deploy/bind-github-installation.ts 12345678 somnio-software        # shadow (default)
 *   ... deploy/bind-github-installation.ts 12345678 somnio-software active  # go live
 *
 * SAFETY: this only writes the github_installation → org mapping row. It never
 * touches the GitHub App's own webhook configuration. The pilot repo uses a
 * separate repo-level webhook; the App's global webhook URL is left pointing at
 * prod (see deploy/SOMNIO-PILOT.md).
 */
import { createDb } from "../packages/shared/src/db";
import { getOrganizationBySlug } from "../packages/shared/src/model/organizations";
import { bindGithubInstallationToOrg } from "../packages/shared/src/model/github-installation";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "DATABASE_URL is not set. Point it at the target Postgres, e.g.\n" +
      "  DATABASE_URL=postgres://... pnpm exec tsx deploy/bind-github-installation.ts <installationId> <orgSlug> [shadow|active]",
  );
  process.exit(1);
}

const [installationIdArg, orgSlug, modeArg] = process.argv.slice(2);

if (!installationIdArg || !orgSlug) {
  console.error(
    "Usage: pnpm exec tsx deploy/bind-github-installation.ts <installationId> <orgSlug> [shadow|active]",
  );
  process.exit(1);
}

if (!/^\d+$/.test(installationIdArg)) {
  console.error(`installationId must be numeric, got: ${installationIdArg}`);
  process.exit(1);
}

if (modeArg !== undefined && modeArg !== "shadow" && modeArg !== "active") {
  console.error(`mode must be 'shadow' or 'active', got: ${modeArg}`);
  process.exit(1);
}
const mode = modeArg as "shadow" | "active" | undefined;

const db = createDb(databaseUrl);

async function main() {
  const org = await getOrganizationBySlug({ db, slug: orgSlug! });

  if (!org) {
    console.error(
      `No organization found with slug '${orgSlug}'. Create the org first (dashboard or deploy/seed-selfhost.ts).`,
    );
    process.exit(1);
  }

  const bound = await bindGithubInstallationToOrg({
    db,
    installationId: installationIdArg!,
    organizationId: org.id,
    mode,
  });

  console.log(
    `\nBound installation ${bound.installationId} -> org '${org.name}' (${org.id})`,
  );
  console.log(`  mode: ${bound.mode}`);
  console.log(
    bound.mode === "shadow"
      ? "\nShadow mode: mentions are ingested and threads appear in the dashboard, but the agent does NOT run and NO GitHub side effects are produced. Flip to 'active' when verified.\n"
      : "\nActive mode: the platform will act on PRs for this installation.\n",
  );

  process.exit(0);
}

main().catch((err) => {
  console.error("Bind failed:", err);
  process.exit(1);
});
