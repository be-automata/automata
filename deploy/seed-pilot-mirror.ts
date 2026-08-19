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
  updateAutomation,
  getAutomations,
} from "../packages/shared/src/model/automations";
import { DBUserMessage } from "../packages/shared/src/db/db-message";
import { loadReviewSkillBody } from "./lib/review-skill-file";

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

// Load BEFORE touching the DB: seeding a review automation whose instruction is
// missing its methodology degrades every subsequent review, so a bad/absent
// skill must abort the seed rather than write a half-formed action.
const reviewSkillBody = loadReviewSkillBody();

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
const MENTION_AUTOMATION_NAME =
  "Mirror: GitHub mention (github-mention-respond)";

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
  // Keyed on (name, repo) — NOT name alone. All onboarded repos live under one
  // org with identical automation names ("Mirror: PR review (github-ops)" ×3 in
  // production), so a name-only key made a re-seed of repo B find repo A's row,
  // overwrite its action with B's text, and never create B's row at all.
  const upsertKey = (name: string, repoFullName: string) =>
    `${name}\u0000${repoFullName}`;
  const existingByName = new Map(
    existing.map((a) => [upsertKey(a.name, a.repoFullName), a]),
  );

  // Idempotent on action content (ADR-036): the old create-if-not-exists guard
  // SKIPPED an existing automation entirely, so a changed review instruction silently
  // never reached an already-onboarded repo — the deployed row kept the old
  // "prod skill: github-ops" text while the seed had the new inlined-contract
  // instruction (the phase-2 acceptance gap that cost two runs). Now: CREATE if
  // missing, else UPDATE the action to match. This is what makes an instruction /
  // skill / review-contract change actually reach onboarded repos — load-bearing for
  // Somnio onboarding and every future contract change.
  async function upsertAutomation(
    automation: Parameters<typeof createAutomation>[0]["automation"],
  ) {
    const existingA = existingByName.get(
      upsertKey(automation.name, automation.repoFullName),
    );
    if (!existingA) {
      await createAutomation({
        db,
        userId: ownerUserId,
        accessTier: "pro",
        organizationId: org.id,
        automation,
      });
      console.log(`Created automation: ${automation.name}`);
    } else {
      await updateAutomation({
        db,
        userId: ownerUserId,
        accessTier: "pro",
        automationId: existingA.id,
        organizationId: org.id,
        // repoFullName/branchName ride along so a matched row can never keep a
        // stale repo or base branch (defense in depth on top of the composite key).
        updates: {
          action: automation.action,
          repoFullName: automation.repoFullName,
          branchName: automation.branchName,
        },
      });
      console.log(`Updated automation action: ${automation.name}`);
    }
  }

  await upsertAutomation({
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
        // The instruction INLINES the minimal wire contract (verdict enum +
        // fenced-json + commit field) AND the full methodology body, read at seed
        // time from the tracked deploy/skills/github-ops/SKILL.md.
        //
        // Resolves TODO(rev3-skill-path-portable): the methodology used to be an
        // absolute per-box HOME path read as TEXT (no $HOME expansion), so it only
        // resolved on the pilot box, and the installed copy could drift from the
        // tracked one with nothing comparing them. Inlining
        // means the agent needs no box-local file and there is exactly one copy.
        // Skill edits reach onboarded repos via upsertAutomation's action update.
        message: userMessage(
          `A pull request was opened or updated in ${repoFullName}. Perform a substantive PR review.\n\n` +
            `You are running as a REVIEW agent: you have NO gh and NO GitHub token, so you cannot post to GitHub. You deliver your verdict by EMITTING it as your FINAL message — a single fenced \`\`\`json block with EXACTLY this shape:\n` +
            `{ "verdict": "approve" | "request_changes" | "comment", "commit": "<the HEAD sha you reviewed, from \`git rev-parse HEAD\`>", "summary": "<verdict rationale>", "findings": [ { "severity": "info" | "warning" | "error" | "critical", "path": "<file>", "line": <number>, "body": "<one concrete finding>", "quote": "<verbatim source line(s) at path:line, from a fresh Read at HEAD>" } ] }\n` +
            `The control plane posts your review exactly once from that block.\n\n` +
            `Compute the PR delta with \`git diff origin/main...HEAD\` (the base branch is \`main\`; its ref is pre-fetched + deepened to the merge-base so this resolves OFFLINE) and Read/Grep/Glob to inspect files at HEAD. Do NOT use \`git diff HEAD~1...HEAD\` (the clone is shallow) and do NOT run gh. Emit the fenced-json block exactly once, then stop.\n\n` +
            `Follow the review methodology below in full (verify-before-block quote rules, severity→verdict mapping, the six review dimensions).\n\n` +
            `----- BEGIN REVIEW METHODOLOGY -----\n${reviewSkillBody}\n----- END REVIEW METHODOLOGY -----`,
        ),
      },
    },
  });

  await upsertAutomation({
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
  });

  await upsertAutomation({
    name: MENTION_AUTOMATION_NAME,
    triggerType: "github_mention",
    // All-authors mention routing: fire for @-mentions from any author; the comment
    // body is the agent's input.
    triggerConfig: {
      filter: { includeOtherAuthors: true, includeBotMentions: false },
    },
    repoFullName,
    branchName: "main",
    action: {
      type: "user_message",
      config: { message: userMessage("Respond to the GitHub mention.") },
    },
  });

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
