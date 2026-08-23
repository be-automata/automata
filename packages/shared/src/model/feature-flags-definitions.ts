/**
 * Feature flag definitions.
 *
 * This is used to define and create feature flags automatically.
 *
 * The default value is used to determine the value of the feature flag for a user
 * if they have not overridden it.
 *
 * The description field is optional but highly recommended to help admins understand
 * what the feature flag is used for.
 *
 * You can configure global/per user settings for each feature flag in the admin page.
 *
 * How to delete a feature flag:
 * To clean up a feature flag, delete it here and delete the definition in the admin page.
 * Make sure you delete the definition and usages in code before deleting the feature flag
 * in the admin page.
 */
export type FeatureFlagDefinition = {
  // Default value for all users unless overridden globally or per-user
  defaultValue: boolean;
  // If true, users who opt-in to Preview features will have this flag enabled by default
  enabledForPreview?: boolean;
  description: string;
};

export const featureFlagsDefinitions = {
  autoUpdateDaemon: {
    defaultValue: false,
    description:
      "Automatically updates the daemon in sandboxes when new versions are available.",
  },
  geminiAgent: {
    defaultValue: false,
    enabledForPreview: true,
    description: "Enables the Gemini agent for users.",
  },
  allowUnlimitedAutomations: {
    defaultValue: false,
    description:
      "Allows users to create unlimited automations. If enabled, users are allowed to create more than 5 automations.",
  },
  autoCompactOnContextError: {
    defaultValue: false,
    description:
      "Automatically compacts the thread when an out-of-context error is detected during agent execution.",
  },
  contextUsageChip: {
    defaultValue: false,
    enabledForPreview: false,
    description:
      "Shows a neutral context usage chip in chat (replaces warning). Always visible for Claude Code when enabled.",
  },
  daytonaOptionsForSandboxProvider: {
    defaultValue: false,
    enabledForPreview: false,
    description:
      "Enables the Daytona sandbox provider option in settings, allowing users to select Daytona as their sandbox provider.",
  },
  mcpPermissionPrompt: {
    defaultValue: false,
    enabledForPreview: false,
    description:
      "Enables the MCP PermissionPrompt tool for handling permission requests in plan mode.",
  },
  createGitHubChecksForAutomations: {
    defaultValue: false,
    enabledForPreview: false,
    description:
      "Creates GitHub check runs for automations on pull requests when the automation owner is the PR author. When disabled, automations still run but do not create GitHub checks.",
  },
  enableEmailNotifs: {
    defaultValue: false,
    description:
      "Enables sending transactional email notifications via Loops (task completion emails).",
  },
  enableLargeSandboxSize: {
    defaultValue: false,
    description: "Enables choosing a large sandbox size in the settings.",
  },
  forceDaytonaSandbox: {
    defaultValue: false,
    enabledForPreview: false,
    description:
      "Forces the user to use Daytona sandbox provider regardless of their sandbox provider setting.",
  },
  batchGitHubMentions: {
    defaultValue: false,
    enabledForPreview: false,
    description:
      "Batches concurrent GitHub @-mentions within a 1-minute window to prevent creating multiple sandboxes when users submit code reviews with many mentions.",
  },
  enableThreadChatCreation: {
    defaultValue: false,
    enabledForPreview: false,
    description:
      "Enables the creation of thread chats data model vs regular threads.",
  },
  opencodeGemini3ProModelOption: {
    defaultValue: false,
    enabledForPreview: false,
    description:
      "Enables the option to use the Gemini 3 Pro model for OpenCode.",
  },
  opencodeOpenAIAnthropicModelOption: {
    defaultValue: false,
    enabledForPreview: false,
    description: "Enables the option to use the OpenAI model for OpenCode.",
  },
  branchCreationToggle: {
    defaultValue: false,
    enabledForPreview: true,
    description:
      "Enables the branch creation toggle in the prompt box tool belt, allowing users to choose whether to create a new branch or work on the selected branch.",
  },
  forkTask: {
    defaultValue: false,
    enabledForPreview: true,
    description:
      "Enables forking tasks from the latest agent message, allowing users to create a new task with a compacted summary of the existing task and optionally use the current branch as a base.",
  },
  imageDiffView: {
    defaultValue: false,
    enabledForPreview: true,
    description:
      "Enables the image diff view for binary image file changes in git diffs, showing a side-by-side comparison of before/after images.",
  },
  shutdownMode: {
    defaultValue: false,
    description:
      "Enable shutdown mode - shows shutdown banner and blocks new subscriptions. Used for Terragon shutdown on February 14th, 2026.",
  },
  sandboxCredentialBroker: {
    defaultValue: false,
    enabledForPreview: false,
    description:
      "Per-org rollout gate for the Docker sandbox credential broker (#114). When enabled for the creating user, Docker sandboxes receive a per-run bearer via a host-side sidecar instead of the raw GitHub installation token. Evaluated server-side per user (the flag system's closest fit to per-org, since org-scoped overrides do not exist); the SANDBOX_CREDENTIAL_BROKER=on env var remains a global force-on kill switch. Only affects the Docker provider.",
  },
} as const satisfies Record<string, FeatureFlagDefinition>;

export type FeatureFlagName = keyof typeof featureFlagsDefinitions;
