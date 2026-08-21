import * as z from "zod/v4";
import { DBUserMessage } from "../db/db-message";

/**
 * The per-trigger `permissionMode` FLOOR config field (#82, ADR-005 §2/§5).
 * Optional and absent-by-default: absent ⇒ `undefined` ⇒ the resolver's
 * `configured ?? default` falls through to today's derived default, so
 * omitting this field on every existing automation reproduces today's
 * behavior exactly (ADR-005's AC4 regression invariant). This is the
 * MECHANISM only — no config UI ships with this ticket (that belongs with
 * the #74-family surface per ADR-005 §5); the value can only ever be
 * TIGHTENED by the server-side floor resolver
 * (`@terragon/review/settings/permission-floor`), never honored as-is.
 */
const permissionModeConfig = z.enum(["review", "plan", "allowAll"]).optional();

export const AutomationTriggerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("manual"),
    config: z.object({}),
  }),
  z.object({
    type: z.literal("schedule"),
    config: z.object({
      cron: z.string(),
      timezone: z.string(),
      permissionMode: permissionModeConfig,
    }),
  }),
  z.object({
    type: z.literal("pull_request"),
    config: z.object({
      filter: z.object({
        includeDraftPRs: z.boolean().optional(),
        includeOtherAuthors: z.boolean().optional(),
        otherAuthors: z
          .string()
          .optional()
          .describe("Comma-separated list of authors to include"),
        // Match PRs from ANY author (unconditional routing — mirror parity).
        includeAllAuthors: z.boolean().optional(),
      }),
      // The events to trigger on.
      on: z.object({
        open: z.boolean().optional(),
        update: z.boolean().optional(),
      }),
      // Auto-archive the task when the agent completes
      autoArchiveOnComplete: z
        .boolean()
        .optional()
        .describe("Automatically archive the task when the agent completes"),
      permissionMode: permissionModeConfig,
    }),
  }),
  z.object({
    type: z.literal("issue"),
    config: z.object({
      filter: z.object({
        includeOtherAuthors: z.boolean().optional(),
        otherAuthors: z
          .string()
          .optional()
          .describe("Comma-separated list of authors to include"),
        // Match issues from ANY author (unconditional routing — mirror parity).
        includeAllAuthors: z.boolean().optional(),
      }),
      // The events to trigger on.
      on: z.object({
        open: z.boolean().optional(),
      }),
      // Auto-archive the task when the agent completes
      autoArchiveOnComplete: z
        .boolean()
        .optional()
        .describe("Automatically archive the task when the agent completes"),
      permissionMode: permissionModeConfig,
    }),
  }),
  z.object({
    type: z.literal("github_mention"),
    config: z.object({
      filter: z.object({
        // Include PR/Issues created by other authors
        includeOtherAuthors: z.boolean().optional(),
        otherAuthors: z
          .string()
          .optional()
          .describe("Comma-separated list of authors to include"),
        // Include mentions from bot users
        includeBotMentions: z.boolean().optional(),
        // Specific bot usernames to create tasks for (comma-separated)
        botUsernames: z
          .string()
          .optional()
          .describe("Comma-separated list of bot usernames to include"),
      }),
      permissionMode: permissionModeConfig,
    }),
  }),
]);
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;
export type AutomationTriggerType = AutomationTrigger["type"];
export type AutomationTriggerConfig = AutomationTrigger["config"];

export type ScheduleTrigger = Extract<AutomationTrigger, { type: "schedule" }>;
export type ScheduleTriggerConfig = ScheduleTrigger["config"];
export type PullRequestTrigger = Extract<
  AutomationTrigger,
  { type: "pull_request" }
>;
export type PullRequestTriggerConfig = PullRequestTrigger["config"];
export type IssueTrigger = Extract<AutomationTrigger, { type: "issue" }>;
export type IssueTriggerConfig = IssueTrigger["config"];
export type GitHubMentionTrigger = Extract<
  AutomationTrigger,
  { type: "github_mention" }
>;
export type GitHubMentionTriggerConfig = GitHubMentionTrigger["config"];

export const triggerTypeLabels: Record<AutomationTriggerType, string> = {
  schedule: "Schedule",
  pull_request: "GitHub Pull Request",
  issue: "GitHub Issue",
  github_mention: "GitHub Mention",
  manual: "Manual",
};

export const triggerTypeDescriptions: Record<AutomationTriggerType, string> = {
  schedule: "Schedule the automation to run at a specific frequency.",
  pull_request: "Run the automation in response to a GitHub Pull Request.",
  issue: "Run the automation in response to a GitHub Issue.",
  github_mention:
    "Customize the behavior when @terragon-labs is mentioned on GitHub.",
  manual: "Run the automation manually.",
};

// Thread actions
export const AutomationActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user_message"),
    config: z.object({
      message: z.custom<DBUserMessage>(),
    }),
  }),
  // A REFERENCE to a live repo skill (issue #54): instead of a message snapshot
  // frozen into this jsonb at seed time, the control plane resolves the skill's
  // current version at thread-creation time — so an accepted skill edit is live
  // on the next run with no seed script and no redeploy. `version: "latest"`
  // follows the skill's current pointer; any other value pins a version id.
  z.object({
    type: z.literal("skill_message"),
    config: z.object({
      skillName: z.string(),
      version: z
        .string()
        .describe(`'latest' (follow the current version) or a version-id pin`),
    }),
  }),
]);
export type AutomationAction = z.infer<typeof AutomationActionSchema>;
export type AutomationActionType = AutomationAction["type"];
export type SkillMessageAction = Extract<
  AutomationAction,
  { type: "skill_message" }
>;

export const actionTypeLabels: Record<AutomationActionType, string> = {
  user_message: "Create Thread",
  skill_message: "Create Thread from Skill",
};

export function isRepoBranchRelevant(triggerType: AutomationTriggerType) {
  switch (triggerType) {
    case "pull_request":
    case "issue":
    case "github_mention":
      return false;
    case "schedule":
    case "manual":
      return true;
    default: {
      const _exhaustiveCheck: never = triggerType;
      console.error("Unexpected trigger type:", _exhaustiveCheck);
      return true;
    }
  }
}

export function isSkipSetupRelevant(triggerType: AutomationTriggerType) {
  switch (triggerType) {
    case "pull_request":
    case "issue":
    case "github_mention":
      return false;
    case "schedule":
    case "manual":
      return true;
    default: {
      const _exhaustiveCheck: never = triggerType;
      console.error("Unexpected trigger type:", _exhaustiveCheck);
      return true;
    }
  }
}
