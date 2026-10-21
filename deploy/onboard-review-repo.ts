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
 * `--mention` (the org-owned mention lane) writes NO settings row and upserts,
 * keyed by (organization, repo, name 'GitHub mention (<skill>)'), ONE
 * github_mention automation: filter { orgLane: true }, action skill_message
 * { skillName, version 'latest', model }, disableGitCheckpointing true, owned
 * by the org owner, created DISABLED unless --enable. Once enabled, every
 * mention on the repo goes through that lane instead of the per-user path.
 *   DATABASE_URL=postgres://... pnpm exec tsx deploy/onboard-review-repo.ts \
 *     <orgSlug> <owner/repo> github-mention --mention --model <model> [--enable]
 *
 * `--companion` (the PR companion lane) writes NO settings row and upserts,
 * keyed by (organization, repo, name 'PR companion (<skill>)'), ONE
 * pull_request automation: trigger on open + update, filter includeAllAuthors
 * + excludeBotSenders + companion, permissionMode 'review', action
 * skill_message { skillName, version 'latest', model },
 * disableGitCheckpointing true, owned by the org owner, created DISABLED
 * unless --enable. It runs next to the review automation and reports as one
 * PR comment, never as a review.
 *   DATABASE_URL=postgres://... pnpm exec tsx deploy/onboard-review-repo.ts \
 *     <orgSlug> <owner/repo> --companion flutter-pr-companion --model <model> [--enable]
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
  type OnboardLane,
  buildCompanionAutomation,
  buildMentionAutomation,
  buildReviewAutomation,
  buildReviewSettingsPatch,
  diffFields,
  isCompanionRow,
  laneAutomationName,
  parseOnboardArgs,
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
    : args.kind === "configure-mention"
      ? buildMentionAutomation({
          ...args,
          model: AIModelSchema.parse(args.model),
        })
      : args.kind === "configure-companion"
        ? buildCompanionAutomation({
            ...args,
            model: AIModelSchema.parse(args.model),
          })
        : null;
const lane: OnboardLane =
  args.kind === "flip"
    ? args.lane
    : args.kind === "configure-mention"
      ? "mention"
      : args.kind === "configure-companion"
        ? "companion"
        : "review";
if (desired) assertSchemaKeeps(desired);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  fail(`DATABASE_URL is not set. Point it at the target Postgres.\n\n${USAGE}`);
}
const db = createDb(databaseUrl);
const tag = args.dryRun ? "[dry-run] " : "";

/**
 * Every automation of the lane's trigger type, all owners: the upsert key is
 * (org, repo, name) regardless of owner, so a row another member created must
 * be found (and refused) rather than duplicated.
 */
async function listLaneAutomations() {
  const pageSize = 500;
  const rows: Awaited<ReturnType<typeof getAllAutomationsForAdmin>> = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await getAllAutomationsForAdmin({
      db,
      limit: pageSize,
      offset,
      triggerType: lane === "mention" ? "github_mention" : "pull_request",
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
  automation:
    | ReturnType<typeof buildReviewAutomation>
    | ReturnType<typeof buildMentionAutomation>
    | ReturnType<typeof buildCompanionAutomation>,
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
          `knows filter.excludeBotSenders, filter.orgLane, filter.companion and skill_message.model.`,
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

  const name = laneAutomationName(lane, parsed.skillName);
  const repoKey = parsed.repoFullName.toLowerCase();
  const all = await listLaneAutomations();
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
  // A companion is not a review lane: it neither collides with the review
  // automation nor with another companion skill (each has its own comment),
  // so only same-lane rows warn.
  const others =
    lane === "companion"
      ? []
      : all.filter(
          (a) =>
            a.enabled &&
            a.repoFullName.toLowerCase() === repoKey &&
            a.id !== existing?.id &&
            !isCompanionRow(a),
        );
  for (const other of others) {
    console.warn(
      lane === "mention"
        ? `WARNING: another ENABLED github_mention automation also matches ` +
            `${parsed.repoFullName}: '${other.name}' (${other.id}, org ` +
            `${other.organizationId ?? "none"}). With an org-lane automation enabled ` +
            `the per-user mention automations no longer run on this repo.`
        : `WARNING: another ENABLED pull_request automation also fires on ` +
            `${parsed.repoFullName}: '${other.name}' (${other.id}, org ` +
            `${other.organizationId ?? "none"}). Two review lanes on one repo post two reviews.`,
    );
  }

  if (parsed.kind === "flip") {
    if (!existing) {
      fail(
        `No automation '${name}' for ${parsed.repoFullName} in '${parsed.orgSlug}'. ` +
          (lane === "review"
            ? `Run with --tolerance and --model to create it first.`
            : `Run with --${lane} --model to create it first.`),
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

  if (parsed.kind === "configure") {
    await configureReviewSettings(parsed, org, ownerUserId);
  }
  await upsertLaneAutomation(parsed, desired, org, ownerUserId, name, existing);
}

async function configureReviewSettings(
  parsed: Extract<RunArgs, { kind: "configure" }>,
  org: { id: string; slug: string },
  ownerUserId: string,
) {
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
}

async function upsertLaneAutomation(
  parsed: Exclude<RunArgs, { kind: "flip" }>,
  desired:
    | ReturnType<typeof buildReviewAutomation>
    | ReturnType<typeof buildMentionAutomation>
    | ReturnType<typeof buildCompanionAutomation>,
  org: { id: string; slug: string },
  ownerUserId: string,
  name: string,
  existing: Awaited<ReturnType<typeof listLaneAutomations>>[number] | undefined,
) {
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
      ...("disableGitCheckpointing" in desired
        ? { disableGitCheckpointing: desired.disableGitCheckpointing }
        : {}),
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
