/**
 * Onboard one repository onto the PR-review lane (A10): the repo's review
 * settings row plus ONE pull_request automation that runs a review skill,
 * so a cutover step is one command and its rollback (`--disable`) is one more.
 *
 * Usage (DATABASE_URL must point at the target Postgres):
 *   DATABASE_URL=postgres://... pnpm exec tsx deploy/onboard-review-repo.ts \
 *     <orgSlug> <owner/repo> <skillName> --tolerance info|warning|error \
 *     [--drafts] --model <model> [--enable|--disable] [--dry-run]
 *   # flip only (the automation must exist):
 *   DATABASE_URL=postgres://... pnpm exec tsx deploy/onboard-review-repo.ts \
 *     <orgSlug> <owner/repo> <skillName> --enable|--disable [--dry-run]
 *
 * Configure writes:
 *   - repo_review_settings (org, repo): block_tolerance, review_draft_prs
 *     (true with --drafts), review_mode 'classic', review_max_turns 120,
 *     supersede_policy NULL (inherit: org default, then newest-wins).
 *   - automations, keyed by (organization, repo, name 'PR review (<skill>)'):
 *     trigger pull_request on open + update, filter includeAllAuthors +
 *     includeDraftPRs (= --drafts) + excludeBotSenders, action skill_message
 *     { skillName, version 'latest', model }, owned by the org owner. A new
 *     row is created DISABLED unless --enable; an existing row keeps its
 *     enabled flag unless --enable/--disable is given.
 * Push the skill itself first with deploy/skill-push.ts: the automation only
 * references it by name.
 *
 * `--dry-run` prints the field diff and writes nothing. Unknown flags are a
 * hard error. Re-running with the same arguments is a no-op.
 */
import { createDb } from "../packages/shared/src/db";
import {
  getOrganizationBySlug,
  getOrganizationOwnerUserId,
} from "../packages/shared/src/model/organizations";
import {
  createAutomation,
  getAllAutomationsForAdmin,
  updateAutomation,
} from "../packages/shared/src/model/automations";
import {
  getRepoReviewSetting,
  upsertRepoReviewSetting,
} from "../packages/shared/src/model/repo-review-settings";
import {
  AutomationActionSchema,
  AutomationTriggerSchema,
} from "../packages/shared/src/automations";
import { AIModelSchema } from "../packages/agent/src/types";
import { BLOCK_TOLERANCES } from "../packages/review/src/review/severity-policy";
import {
  OnboardArgsError,
  USAGE,
  type OnboardArgs,
  buildReviewAutomation,
  buildReviewSettingsPatch,
  diffFields,
  parseOnboardArgs,
  reviewAutomationName,
  stableStringify,
} from "./lib/onboard-review-repo-args";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

type RunArgs = Exclude<OnboardArgs, { kind: "help" }>;

function parseArgsOrExit(): RunArgs {
  let parsed: OnboardArgs;
  try {
    parsed = parseOnboardArgs(process.argv.slice(2), {
      models: AIModelSchema.options,
      tolerances: BLOCK_TOLERANCES,
    });
  } catch (err) {
    if (err instanceof OnboardArgsError) fail(`${err.message}\n\n${USAGE}`);
    throw err;
  }
  if (parsed.kind === "help") {
    console.log(USAGE);
    process.exit(0);
  }
  return parsed;
}

const args = parseArgsOrExit();

// Built and schema-checked BEFORE any DB access, so a wrong checkout fails
// without touching the database.
const desired =
  args.kind === "configure"
    ? buildReviewAutomation({
        ...args,
        // Already checked against AIModelSchema.options; parse narrows the type.
        model: AIModelSchema.parse(args.model),
      })
    : null;
if (desired) assertSchemaKeeps(desired);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  fail(`DATABASE_URL is not set. Point it at the target Postgres.\n\n${USAGE}`);
}
const db = createDb(databaseUrl);
const tag = args.dryRun ? "[dry-run] " : "";

/**
 * Every pull_request automation, all owners: the upsert key is (org, repo,
 * name) regardless of owner, so a row another member created must be found
 * (and refused) rather than duplicated.
 */
async function listPullRequestAutomations() {
  const pageSize = 500;
  const rows: Awaited<ReturnType<typeof getAllAutomationsForAdmin>> = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await getAllAutomationsForAdmin({
      db,
      limit: pageSize,
      offset,
      triggerType: "pull_request",
    });
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

/**
 * Refuse to write a field the automation schemas in THIS checkout would drop
 * (zod strips unknown keys): the webhook handler of a www built from it would
 * ignore excludeBotSenders / model, so bots get reviewed on the wrong model.
 */
function assertSchemaKeeps(
  automation: ReturnType<typeof buildReviewAutomation>,
) {
  const trigger = {
    type: automation.triggerType,
    config: automation.triggerConfig,
  };
  const parsedTrigger = AutomationTriggerSchema.parse(trigger);
  const parsedAction = AutomationActionSchema.parse(automation.action);
  for (const [label, input, parsed] of [
    ["trigger", trigger, parsedTrigger],
    ["action", automation.action, parsedAction],
  ] as const) {
    if (stableStringify(parsed) !== stableStringify(input)) {
      fail(
        `The automation ${label} schema in this checkout drops fields of\n` +
          `  ${stableStringify(input)}\n(parsed: ${stableStringify(parsed)}).\n` +
          `Run this script from a checkout whose packages/shared/src/automations ` +
          `knows filter.excludeBotSenders and skill_message.model.`,
      );
    }
  }
}

async function main(parsed: RunArgs) {
  const org = await getOrganizationBySlug({ db, slug: parsed.orgSlug });
  if (!org) {
    fail(`No organization found with slug '${parsed.orgSlug}'.`);
  }
  const ownerUserId = await getOrganizationOwnerUserId({
    db,
    organizationId: org.id,
  });
  if (!ownerUserId) {
    fail(`Org '${parsed.orgSlug}' has no members. Add an owner first.`);
  }

  const name = reviewAutomationName(parsed.skillName);
  const repoKey = parsed.repoFullName.toLowerCase();
  const all = await listPullRequestAutomations();
  const matches = all.filter(
    (a) =>
      a.organizationId === org.id &&
      a.name === name &&
      a.repoFullName.toLowerCase() === repoKey,
  );
  if (matches.length > 1) {
    fail(
      `${matches.length} automations named '${name}' exist for ` +
        `${parsed.repoFullName} in '${parsed.orgSlug}' (${matches.map((a) => a.id).join(", ")}). ` +
        `Delete the extras in the dashboard first.`,
    );
  }
  const existing = matches[0];
  const others = all.filter(
    (a) =>
      a.enabled &&
      a.repoFullName.toLowerCase() === repoKey &&
      a.id !== existing?.id,
  );
  for (const other of others) {
    console.warn(
      `WARNING: another ENABLED pull_request automation also fires on ` +
        `${parsed.repoFullName}: '${other.name}' (${other.id}, org ` +
        `${other.organizationId ?? "none"}). Two review lanes on one repo post two reviews.`,
    );
  }

  if (parsed.kind === "flip") {
    if (!existing) {
      fail(
        `No automation '${name}' for ${parsed.repoFullName} in '${parsed.orgSlug}'. ` +
          `Run with --tolerance and --model to create it first.`,
      );
    }
    if (existing.enabled === parsed.enabled) {
      console.log(
        `${tag}Automation '${name}' (${existing.id}) is already ` +
          `${parsed.enabled ? "enabled" : "disabled"} — no write.`,
      );
      return;
    }
    console.log(
      `${tag}automation '${name}' (${existing.id}): enabled: ` +
        `${existing.enabled} → ${parsed.enabled}`,
    );
    if (!parsed.dryRun) {
      await updateAutomation({
        db,
        userId: existing.userId,
        accessTier: "pro",
        automationId: existing.id,
        organizationId: org.id,
        updates: { enabled: parsed.enabled },
      });
      console.log(
        `Automation ${parsed.enabled ? "ENABLED" : "disabled"}: ${name} (${parsed.repoFullName}).`,
      );
    }
    return;
  }

  // ---- Configure: settings row first, then the automation ------------------
  if (!desired) {
    throw new Error("unreachable: a configure run without a built automation");
  }
  // Refuse BEFORE any write: failing here after the settings upsert would
  // leave the repo half-configured.
  if (existing && existing.userId !== ownerUserId) {
    fail(
      `Automation '${name}' (${existing.id}) is owned by user ${existing.userId}, ` +
        `not the org owner ${ownerUserId}. Its runs would use that user's ` +
        `credentials; reassign or delete it in the dashboard, then re-run.`,
    );
  }

  const settingsPatch = buildReviewSettingsPatch(parsed);
  const currentSettings = await getRepoReviewSetting({
    db,
    organizationId: org.id,
    repoFullName: parsed.repoFullName,
  });
  const settingsDiff = diffFields(currentSettings, settingsPatch);
  if (settingsDiff.length === 0) {
    console.log(`${tag}repo_review_settings: unchanged — no write.`);
  } else {
    console.log(
      `${tag}repo_review_settings (${org.slug}, ${parsed.repoFullName.toLowerCase()}) ` +
        `${currentSettings ? "UPDATE" : "CREATE"}:\n  ${settingsDiff.join("\n  ")}`,
    );
    if (!parsed.dryRun) {
      await upsertRepoReviewSetting({
        db,
        organizationId: org.id,
        repoFullName: parsed.repoFullName,
        patch: settingsPatch,
        updatedByUserId: ownerUserId,
      });
    }
  }

  if (!existing) {
    const enabled = parsed.enabled ?? false;
    console.log(
      `${tag}automation '${name}' CREATE (owner ${ownerUserId}, enabled ${enabled}):\n  ` +
        diffFields(undefined, { ...desired, enabled }).join("\n  "),
    );
    if (!parsed.dryRun) {
      const created = await createAutomation({
        db,
        userId: ownerUserId,
        accessTier: "pro",
        organizationId: org.id,
        automation: { ...desired, enabled },
      });
      console.log(`Created automation ${created.id}.`);
    }
  } else {
    const updates = {
      triggerType: desired.triggerType,
      triggerConfig: desired.triggerConfig,
      repoFullName: desired.repoFullName,
      branchName: desired.branchName,
      action: desired.action,
      ...(parsed.enabled !== undefined ? { enabled: parsed.enabled } : {}),
    };
    const automationDiff = diffFields(existing, updates);
    if (automationDiff.length === 0) {
      console.log(
        `${tag}automation '${name}' (${existing.id}): unchanged — no write.`,
      );
    } else {
      console.log(
        `${tag}automation '${name}' (${existing.id}) UPDATE:\n  ${automationDiff.join("\n  ")}`,
      );
      if (!parsed.dryRun) {
        await updateAutomation({
          db,
          userId: existing.userId,
          accessTier: "pro",
          automationId: existing.id,
          organizationId: org.id,
          updates,
        });
        console.log(`Updated automation ${existing.id}.`);
      }
    }
  }
}

main(args)
  .then(() => {
    console.log(args.dryRun ? "\n[dry-run] nothing was written." : "\nDone.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Onboarding failed:", err);
    process.exit(1);
  });
