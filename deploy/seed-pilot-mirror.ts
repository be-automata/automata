/**
 * Provision a pilot org's mirror automations (prod WORKFLOW.md parity).
 *
 * Defaults target the dogfooding pilot — org slug `beautomata`, repo
 * `be-automata/automata` — but every field is a parameter, so the same script
 * onboards the next org (e.g. Somnio) with different args. Prod orch-agents'
 * WORKFLOW.md routes repo events to skills; this seeds the automation-expressible
 * half of that table for the bound org so that, once the installation is flipped
 * to active, PR-open/update and issue-open events execute (github-ops /
 * github-deep-research equivalents). While the installation is in shadow mode
 * these automations create dashboard-visible tasks but never boot the agent
 * (runAutomation is shadow-aware). The other event classes (review_requested,
 * merged, changes_requested, workflow_run, labeled) are handled by the webhook
 * mirror-intake layer — see mirror-intake.ts.
 *
 * The automations use the `includeAllAuthors` filter so they fire for EVERY PR /
 * issue (unconditional routing), not just the owner's — matching prod's per-repo
 * routing. Tasks are attributed to the org owner.
 *
 * Usage (DATABASE_URL must point at the target Postgres). Positional args and
 * env vars both work; positional wins. Args default to the pilot org:
 *   DATABASE_URL=postgres://... pnpm exec tsx deploy/seed-pilot-mirror.ts \
 *     [orgSlug] [repoFullName] [installationId]
 *   # or: ORG_SLUG=... REPO_FULL_NAME=... INSTALLATION_ID=... pnpm exec tsx deploy/seed-pilot-mirror.ts
 *
 * Examples:
 *   ... deploy/seed-pilot-mirror.ts                                   # beautomata / be-automata/automata
 *   ... deploy/seed-pilot-mirror.ts beautomata be-automata/automata 12345678
 *   ... deploy/seed-pilot-mirror.ts somnio-software somnio-projects/marketplace-monorepo 67890
 *
 * Idempotent: automations are keyed by name per org+user and skipped if present;
 * an installation id (optional) is bound in shadow mode via upsert.
 */
import { createDb } from "../packages/shared/src/db";
import { getOrganizationBySlug } from "../packages/shared/src/model/organizations";
import { getOrganizationOwnerUserId } from "../packages/shared/src/model/organizations";
import { bindGithubInstallationToOrg } from "../packages/shared/src/model/github-installation";
import {
  createAutomation,
  getAutomations,
} from "../packages/shared/src/model/automations";
import { DBUserMessage } from "../packages/shared/src/db/db-message";

// Dogfooding pilot defaults (BeAutomata org, our own platform repo).
const DEFAULT_ORG_SLUG = "beautomata";
const DEFAULT_REPO_FULL_NAME = "be-automata/automata";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "DATABASE_URL is not set. Point it at the target Postgres, e.g.\n" +
      "  DATABASE_URL=postgres://... pnpm exec tsx deploy/seed-pilot-mirror.ts [orgSlug] [repoFullName] [installationId]",
  );
  process.exit(1);
}

const [orgSlugArg, repoFullNameArg, installationIdArg2] = process.argv.slice(2);
const orgSlug = orgSlugArg ?? process.env.ORG_SLUG ?? DEFAULT_ORG_SLUG;
const repoFullName =
  repoFullNameArg ?? process.env.REPO_FULL_NAME ?? DEFAULT_REPO_FULL_NAME;
const installationIdArg = installationIdArg2 ?? process.env.INSTALLATION_ID;
if (installationIdArg !== undefined && !/^\d+$/.test(installationIdArg)) {
  console.error(`installationId must be numeric, got: ${installationIdArg}`);
  process.exit(1);
}
console.log(
  `Seeding mirror automations for org '${orgSlug}', repo '${repoFullName}'` +
    (installationIdArg ? ` (installation ${installationIdArg})` : ""),
);

const db = createDb(databaseUrl);

function userMessage(text: string): DBUserMessage {
  return {
    type: "user",
    model: null,
    parts: [{ type: "text", text }],
    timestamp: new Date().toISOString(),
  };
}

const PR_AUTOMATION_NAME = "Mirror: PR review (github-ops)";
const ISSUE_AUTOMATION_NAME = "Mirror: issue research (github-deep-research)";

async function main() {
  const org = await getOrganizationBySlug({ db, slug: orgSlug });
  if (!org) {
    console.error(
      `No organization found with slug '${orgSlug}'. Create it first (dashboard).`,
    );
    process.exit(1);
  }
  const ownerUserId = await getOrganizationOwnerUserId({
    db,
    organizationId: org.id,
  });
  if (!ownerUserId) {
    console.error(
      `Org '${orgSlug}' has no members. Add an owner before seeding automations.`,
    );
    process.exit(1);
  }

  if (installationIdArg !== undefined) {
    const bound = await bindGithubInstallationToOrg({
      db,
      installationId: installationIdArg,
      organizationId: org.id,
      // Onboard in shadow; flip to active later with deploy/bind-github-installation.ts.
      mode: "shadow",
    });
    console.log(
      `Bound installation ${bound.installationId} -> org '${org.name}' (mode: ${bound.mode})`,
    );
  }

  const existing = await getAutomations({
    db,
    userId: ownerUserId,
    organizationId: org.id,
  });
  const existingNames = new Set(existing.map((a) => a.name));

  if (!existingNames.has(PR_AUTOMATION_NAME)) {
    await createAutomation({
      db,
      userId: ownerUserId,
      accessTier: "pro",
      organizationId: org.id,
      automation: {
        name: PR_AUTOMATION_NAME,
        triggerType: "pull_request",
        triggerConfig: {
          filter: { includeAllAuthors: true, includeDraftPRs: false },
          on: { open: true, update: true },
        },
        repoFullName,
        branchName: "main",
        action: {
          type: "user_message",
          config: {
            message: userMessage(
              `A pull request was opened or updated in ${repoFullName}. Perform a PR review (prod skill: github-ops).`,
            ),
          },
        },
      },
    });
    console.log(`Created automation: ${PR_AUTOMATION_NAME}`);
  } else {
    console.log(`Skipped (exists): ${PR_AUTOMATION_NAME}`);
  }

  if (!existingNames.has(ISSUE_AUTOMATION_NAME)) {
    await createAutomation({
      db,
      userId: ownerUserId,
      accessTier: "pro",
      organizationId: org.id,
      automation: {
        name: ISSUE_AUTOMATION_NAME,
        triggerType: "issue",
        triggerConfig: {
          filter: { includeAllAuthors: true },
          on: { open: true },
        },
        repoFullName,
        branchName: "main",
        action: {
          type: "user_message",
          config: {
            message: userMessage(
              `An issue was opened in ${repoFullName}. Research it (prod skill: github-deep-research).`,
            ),
          },
        },
      },
    });
    console.log(`Created automation: ${ISSUE_AUTOMATION_NAME}`);
  } else {
    console.log(`Skipped (exists): ${ISSUE_AUTOMATION_NAME}`);
  }

  console.log(
    `\nSeeded mirror automations for '${org.name}' (${repoFullName}). While the` +
      ` installation is in shadow mode these create dashboard-visible tasks with` +
      ` no boot; flip to active to execute.\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
