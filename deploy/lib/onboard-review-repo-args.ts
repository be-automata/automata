/**
 * The pure half of deploy/onboard-review-repo.ts (A10): argument parsing and
 * the exact settings patch / automation row the script writes. No imports, so
 * it runs under Node type stripping (CI runs deploy/*.test.ts with
 * `node --test`); the allowed model and tolerance lists are passed in by the
 * script from their owning modules.
 */

export const USAGE =
  "Usage:\n" +
  "  configure: pnpm exec tsx deploy/onboard-review-repo.ts <orgSlug> <owner/repo> <skillName> \\\n" +
  "               --tolerance <info|warning|error> [--drafts] --model <model> [--enable|--disable] [--dry-run]\n" +
  "  flip only: pnpm exec tsx deploy/onboard-review-repo.ts <orgSlug> <owner/repo> <skillName> \\\n" +
  "               --enable|--disable [--mention] [--dry-run]\n" +
  "  mention:   pnpm exec tsx deploy/onboard-review-repo.ts <orgSlug> <owner/repo> <skillName> \\\n" +
  "               --mention --model <model> [--enable|--disable] [--dry-run]\n" +
  "\n" +
  "Configure upserts the repo's review settings (block tolerance, draft reviews,\n" +
  "classic mode, 120 turns, supersede policy inherited) and ONE pull_request\n" +
  "automation named 'PR review (<skillName>)', created disabled unless --enable.\n" +
  "--mention instead upserts ONE org-lane github_mention automation named\n" +
  "'GitHub mention (<skillName>)' (no settings row), created disabled unless --enable.\n" +
  "Flip only changes that automation's enabled flag (with --mention, the mention\n" +
  "automation's). --dry-run prints the diff\n" +
  "and writes nothing. DATABASE_URL must point at the target Postgres.";

/** Fixed per the cutover spec: the legacy lane's turn budget, classic mode. */
export const REVIEW_MAX_TURNS = 120;
export const REVIEW_MODE = "classic";
/** pull_request automations ignore the branch (isRepoBranchRelevant), but the column is NOT NULL. */
export const AUTOMATION_BRANCH_NAME = "main";

export type OnboardArgs =
  | { kind: "help" }
  | {
      kind: "flip";
      /** Which automation the flip targets: the PR review or the mention lane. */
      lane: "review" | "mention";
      orgSlug: string;
      repoFullName: string;
      skillName: string;
      enabled: boolean;
      dryRun: boolean;
    }
  | {
      kind: "configure-mention";
      orgSlug: string;
      repoFullName: string;
      skillName: string;
      model: string;
      /** undefined = create disabled, leave an existing row's flag as is. */
      enabled: boolean | undefined;
      dryRun: boolean;
    }
  | {
      kind: "configure";
      orgSlug: string;
      repoFullName: string;
      skillName: string;
      tolerance: string;
      drafts: boolean;
      model: string;
      /** undefined = create disabled, leave an existing row's flag as is. */
      enabled: boolean | undefined;
      dryRun: boolean;
    };

export class OnboardArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardArgsError";
  }
}

const BOOLEAN_FLAGS = [
  "--drafts",
  "--enable",
  "--disable",
  "--dry-run",
  "--mention",
];
const VALUE_FLAGS = ["--tolerance", "--model"];

/**
 * Parse argv (without node/script). Unknown flags are a HARD error: a typo
 * like `--dryrun` must abort, never fall through to a live write.
 */
export function parseOnboardArgs(
  argv: readonly string[],
  allowed: {
    models: readonly string[];
    tolerances: readonly string[];
  },
): OnboardArgs {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  const positional: string[] = [];
  const seen = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (!BOOLEAN_FLAGS.includes(arg) && !VALUE_FLAGS.includes(arg)) {
      throw new OnboardArgsError(
        `Unknown flag: ${arg}. Known: ${[...VALUE_FLAGS, ...BOOLEAN_FLAGS, "--help"].join(", ")}. ` +
          `Aborting — a mistyped flag must never become a live write.`,
      );
    }
    if (seen.has(arg)) throw new OnboardArgsError(`${arg} given twice.`);
    seen.add(arg);
    if (VALUE_FLAGS.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new OnboardArgsError(`${arg} needs a value.`);
      }
      values.set(arg, value);
      i++;
    }
  }

  if (positional.length !== 3) {
    throw new OnboardArgsError(
      `Expected <orgSlug> <owner/repo> <skillName>, got ${positional.length} positional argument(s).`,
    );
  }
  const [orgSlug, repoFullName, skillName] = positional as [
    string,
    string,
    string,
  ];
  if (!/^[^/\s]+\/[^/\s]+$/.test(repoFullName)) {
    throw new OnboardArgsError(
      `repo must be 'owner/repo', got: ${repoFullName}`,
    );
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(skillName)) {
    throw new OnboardArgsError(
      `skillName must be lowercase letters, digits and dashes, got: ${skillName}`,
    );
  }
  if (seen.has("--enable") && seen.has("--disable")) {
    throw new OnboardArgsError(
      "--enable and --disable are mutually exclusive.",
    );
  }
  const enabled = seen.has("--enable")
    ? true
    : seen.has("--disable")
      ? false
      : undefined;
  const dryRun = seen.has("--dry-run");

  if (seen.has("--mention")) {
    for (const flag of ["--tolerance", "--drafts"]) {
      if (seen.has(flag)) {
        throw new OnboardArgsError(
          `${flag} is a review-lane flag and is not used with --mention.`,
        );
      }
    }
    const model = values.get("--model");
    if (model === undefined) {
      if (enabled === undefined) {
        throw new OnboardArgsError(
          "Nothing to do: pass --model to configure the mention lane, or --enable/--disable to flip it.",
        );
      }
      return {
        kind: "flip",
        lane: "mention",
        orgSlug,
        repoFullName,
        skillName,
        enabled,
        dryRun,
      };
    }
    if (!allowed.models.includes(model)) {
      throw new OnboardArgsError(`--model is not a known model: ${model}`);
    }
    return {
      kind: "configure-mention",
      orgSlug,
      repoFullName,
      skillName,
      model,
      enabled,
      dryRun,
    };
  }

  const configuring =
    values.has("--tolerance") || values.has("--model") || seen.has("--drafts");
  if (!configuring) {
    if (enabled === undefined) {
      throw new OnboardArgsError(
        "Nothing to do: pass --tolerance and --model to configure, or --enable/--disable to flip.",
      );
    }
    return {
      kind: "flip",
      lane: "review",
      orgSlug,
      repoFullName,
      skillName,
      enabled,
      dryRun,
    };
  }

  const tolerance = values.get("--tolerance");
  if (tolerance === undefined) {
    throw new OnboardArgsError("--tolerance is required when configuring.");
  }
  if (!allowed.tolerances.includes(tolerance)) {
    throw new OnboardArgsError(
      `--tolerance must be one of ${allowed.tolerances.join(", ")}, got: ${tolerance}`,
    );
  }
  const model = values.get("--model");
  if (model === undefined) {
    throw new OnboardArgsError("--model is required when configuring.");
  }
  if (!allowed.models.includes(model)) {
    throw new OnboardArgsError(`--model is not a known model: ${model}`);
  }
  return {
    kind: "configure",
    orgSlug,
    repoFullName,
    skillName,
    tolerance,
    drafts: seen.has("--drafts"),
    model,
    enabled,
    dryRun,
  };
}

/** The automation's upsert key within (organization, repo). */
export function reviewAutomationName(skillName: string): string {
  return `PR review (${skillName})`;
}

/** The `repo_review_settings` patch a configure run writes. */
export function buildReviewSettingsPatch({
  tolerance,
  drafts,
}: {
  tolerance: string;
  drafts: boolean;
}) {
  return {
    blockTolerance: tolerance,
    reviewDraftPrs: drafts,
    reviewMode: REVIEW_MODE,
    reviewMaxTurns: REVIEW_MAX_TURNS,
    // NULL = no repo override: the org default, then newest-wins, applies.
    supersedePolicy: null,
  };
}

/**
 * The automation row (minus owner/org/enabled) a configure run upserts.
 * Generic in the model so the script can pass its schema-narrowed type.
 */
export function buildReviewAutomation<Model extends string>({
  repoFullName,
  skillName,
  drafts,
  model,
}: {
  repoFullName: string;
  skillName: string;
  drafts: boolean;
  model: Model;
}) {
  return {
    name: reviewAutomationName(skillName),
    triggerType: "pull_request" as const,
    triggerConfig: {
      filter: {
        includeAllAuthors: true,
        includeDraftPRs: drafts,
        excludeBotSenders: true,
      },
      on: { open: true, update: true },
    },
    repoFullName,
    branchName: AUTOMATION_BRANCH_NAME,
    action: {
      type: "skill_message" as const,
      config: { skillName, version: "latest", model },
    },
  };
}

/** The mention automation's upsert key within (organization, repo). */
export function mentionAutomationName(skillName: string): string {
  return `GitHub mention (${skillName})`;
}

/**
 * The org-lane mention automation (minus owner/org/enabled) a `--mention`
 * configure run upserts: the repo's mentions run the skill as the automation
 * owner, and the thread never auto-commits or opens a pull request.
 */
export function buildMentionAutomation<Model extends string>({
  repoFullName,
  skillName,
  model,
}: {
  repoFullName: string;
  skillName: string;
  model: Model;
}) {
  return {
    name: mentionAutomationName(skillName),
    triggerType: "github_mention" as const,
    triggerConfig: { filter: { orgLane: true } },
    repoFullName,
    branchName: AUTOMATION_BRANCH_NAME,
    action: {
      type: "skill_message" as const,
      config: { skillName, version: "latest", model },
    },
    disableGitCheckpointing: true,
  };
}

/**
 * JSON.stringify with recursively sorted object keys: Postgres jsonb does not
 * keep key order, so a stored row only compares equal through this.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

/**
 * Field-by-field diff of `desired` against `current` (undefined = no row).
 * Returns one `field: from → to` line per changed field; empty = no change.
 */
export function diffFields(
  current: Record<string, unknown> | undefined,
  desired: Record<string, unknown>,
): string[] {
  const lines: string[] = [];
  for (const [field, to] of Object.entries(desired)) {
    const from = current?.[field];
    if (
      current !== undefined &&
      stableStringify(from) === stableStringify(to)
    ) {
      continue;
    }
    lines.push(
      `${field}: ${current === undefined ? "(no row)" : stableStringify(from ?? null)} → ${stableStringify(to)}`,
    );
  }
  return lines;
}
