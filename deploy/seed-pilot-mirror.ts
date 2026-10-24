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
 * Skills (#54 C3): the automation rows hold `skill_message` REFERENCES; the
 * instruction text itself is seeded as `repo_skill_versions` rows (source
 * 'seed', idempotent by content sha against full history) and resolved live
 * at thread creation. Editing a skill from the dashboard or
 * `deploy/skill-push.ts` is live on the next run — this seed only needs
 * re-running to onboard a repo or push a CHANGED tracked default.
 *
 * Usage (DATABASE_URL must point at the target Postgres). Positional args and
 * env vars both work; positional wins. Args default to the pilot org:
 *   DATABASE_URL=postgres://... pnpm exec tsx deploy/seed-pilot-mirror.ts \
 *     [orgSlug] [repoFullName] [installationId] [--dry-run]
 *   # or: ORG_SLUG=... REPO_FULL_NAME=... INSTALLATION_ID=... pnpm exec tsx deploy/seed-pilot-mirror.ts
 *
 * `--dry-run` prints every skill-version and automation-action diff and writes
 * NOTHING — the owner-sign-off artifact for production cutovers.
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
import {
  computeContentSha,
  createRepoSkillVersion,
  listSkillVersions,
} from "../packages/shared/src/model/repo-skills";
import { loadReviewSkillBody } from "./lib/review-skill-file";
import { buildSeedSkillBodies } from "./lib/seed-skill-bodies";
// Key-order-insensitive (jsonb-round-trip-stable) comparison of actions.
import { stableStringify } from "./lib/onboard-review-repo-args";
import { validateSkillBodyForSave } from "../apps/www/src/server-lib/review/skill-save-checks";

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

// --dry-run: print every skill-version and automation diff, write NOTHING.
// This is the owner-sign-off artifact for the #54 C3 production cutover.
// Unknown --flags are a HARD ERROR, never silently dropped: a typo like
// `--dryrun` must abort, not fall through to a live production write — the
// exact inversion of the safety the flag exists to provide.
const rawArgs = process.argv.slice(2);
const KNOWN_FLAGS = new Set(["--dry-run"]);
const unknownFlags = rawArgs.filter(
  (a) => a.startsWith("--") && !KNOWN_FLAGS.has(a),
);
if (unknownFlags.length > 0) {
  console.error(
    `Unknown flag(s): ${unknownFlags.join(", ")}. Known: ${[...KNOWN_FLAGS].join(", ")}. ` +
      `Aborting — a mistyped --dry-run must never become a live write.`,
  );
  process.exit(1);
}
const dryRun = rawArgs.includes("--dry-run");
const [orgSlugArg, repoFullNameArg, installationIdArg2] = rawArgs.filter(
  (a) => !a.startsWith("--"),
);
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

/**
 * Load the tracked methodology and compose every seed body (built by
 * deploy/lib/seed-skill-bodies.ts), then validate each one BEFORE any DB
 * access. Seeding a review automation whose instruction is missing its
 * methodology degrades every subsequent review, so a bad/absent skill aborts
 * the seed rather than writing a half-formed version.
 *
 * Validator-enforced write surface, same as skill-push/API/dashboard: the
 * dispatch-time contract (`validateSkillBody`) plus the save-time-only rules
 * (`validateSkillBodyForSave`: the PR diff base is `origin/{{baseBranch}}`).
 * The resolver's dispatch-time re-validation is a backstop, not the boundary.
 */
async function loadSkillBodies(): Promise<Record<string, string>> {
  const reviewSkillBody = await loadReviewSkillBody();
  const bodies = buildSeedSkillBodies(reviewSkillBody);
  for (const [skillName, body] of Object.entries(bodies)) {
    try {
      validateSkillBodyForSave(skillName, body, `seed body for '${skillName}'`);
    } catch (err) {
      console.error(
        `Skill body validation failed — aborting before any DB access:\n  ${(err as Error).message}`,
      );
      process.exit(1);
    }
  }
  return bodies;
}

const PR_AUTOMATION_NAME = "Mirror: PR review (github-ops)";
const ISSUE_AUTOMATION_NAME = "Mirror: issue research (github-deep-research)";
const MENTION_AUTOMATION_NAME =
  "Mirror: GitHub mention (github-mention-respond)";

async function main() {
  const SKILL_BODIES = await loadSkillBodies();
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
    if (dryRun) {
      console.log(
        `[dry-run] would bind installation ${installationIdArg} -> org '${org.name}' (mode: shadow)`,
      );
    } else {
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
  }

  // ---- Skill versions (#54 C3) ----------------------------------------------
  // Insert each body as a `source: 'seed'` version — but only when that exact
  // text has never been a version of this skill (sha match against FULL
  // history, not just current). Two properties fall out:
  //   * re-running the seed is a no-op (no version spam, no pointer moves);
  //   * an org's dashboard/API edit stays current unless the tracked default
  //     itself changed — a changed seed body IS meant to go live (same
  //     semantics the old inline upsert had), and the edit remains one
  //     pointer-move away in history.
  for (const [skillName, body] of Object.entries(SKILL_BODIES)) {
    const sha = computeContentSha(body);
    const history = await listSkillVersions({
      db,
      organizationId: org.id,
      repoFullName,
      skillName,
    });
    const known = history.find((v) => v.contentSha === sha);
    if (known) {
      console.log(
        `Skill '${skillName}': body unchanged (sha ${sha.slice(0, 12)}…, version ${known.id}) — skipping.`,
      );
      continue;
    }
    if (dryRun) {
      console.log(
        `[dry-run] skill '${skillName}': would insert seed version ` +
          `(sha ${sha.slice(0, 12)}…, ${body.length} bytes) and move current` +
          (history.length
            ? ` — replacing current head of ${history.length} existing version(s)`
            : " — first version for this skill"),
      );
      continue;
    }
    const { version } = await createRepoSkillVersion({
      db,
      organizationId: org.id,
      repoFullName,
      skillName,
      body,
      source: "seed",
      createdByUserId: ownerUserId,
    });
    console.log(
      `Skill '${skillName}': seeded version ${version.id} (sha ${sha.slice(0, 12)}…).`,
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
    // One equality predicate for BOTH modes, over exactly the fields the
    // update would write (action + repoFullName + branchName) — so the
    // dry-run's "no write" claim is literally what the live run does, and an
    // unchanged re-seed issues zero UPDATEs. Compared via key-sorted
    // stringify: Postgres jsonb does NOT preserve object key order on
    // round-trip ({skillName, version} reads back as {version, skillName}),
    // so a plain JSON.stringify comparison would never match a stored action.
    const unchanged =
      existingA !== undefined &&
      stableStringify(existingA.action) ===
        stableStringify(automation.action) &&
      existingA.repoFullName === automation.repoFullName &&
      existingA.branchName === automation.branchName;
    if (dryRun) {
      if (!existingA) {
        console.log(
          `[dry-run] would CREATE automation '${automation.name}' with action ` +
            JSON.stringify(automation.action),
        );
      } else if (unchanged) {
        console.log(
          `[dry-run] automation '${automation.name}': unchanged — no write.`,
        );
      } else {
        console.log(
          `[dry-run] would UPDATE automation '${automation.name}' (${existingA.id}):\n` +
            `  from: ${JSON.stringify(existingA.action).slice(0, 200)}…\n` +
            `    to: ${JSON.stringify(automation.action)}`,
        );
      }
      return;
    }
    if (unchanged) {
      console.log(`Automation unchanged, no write: ${automation.name}`);
      return;
    }
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
      // Live-skill REFERENCE (#54 C3): the instruction text lives in the
      // 'github-ops' skill version seeded above (preamble + wire contract +
      // methodology, with {{repoFullName}}/{{baseBranch}} placeholders).
      // runAutomation resolves 'latest' at thread creation, so a dashboard/CLI
      // skill edit is live on the NEXT run — no seed re-run, no redeploy.
      type: "skill_message",
      config: { skillName: "github-ops", version: "latest" },
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
      type: "skill_message",
      config: { skillName: "github-deep-research", version: "latest" },
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
      type: "skill_message",
      config: { skillName: "github-mention", version: "latest" },
    },
  });

  console.log(
    dryRun
      ? `\n[dry-run] complete for '${org.name}' (${repoFullName}) — nothing was written.\n`
      : `\nSeeded skills + mirror automations for '${org.name}' (${repoFullName}). While the` +
          ` installation is in shadow mode these create dashboard-visible tasks with` +
          ` no boot; flip to active to execute.\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
