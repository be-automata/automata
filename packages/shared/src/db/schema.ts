import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
  uniqueIndex,
  AnyPgColumn,
  numeric,
  bigint,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { DBMessage, DBUserMessage } from "./db-message";
import type { CredentialKind } from "../model/credential-kind";
import type { SandboxProvider, SandboxSize } from "@terragon/types/sandbox";
import type { SandboxStatus, BootingSubstatus } from "@terragon/sandbox/types";
import {
  AIModel,
  AIAgent,
  SelectedAIModels,
  AgentModelPreferences,
} from "@terragon/agent/types";
import {
  GithubPRStatus,
  GithubCheckRunConclusion,
  GithubCheckRunStatus,
  ThreadStatus,
  GitDiffStats,
  ThreadErrorMessage,
  GithubPRMergeableState,
  GithubCheckStatus,
  ThreadVisibility,
  UsageEventType,
  UsageSku,
  ClaudeOrganizationType,
  ThreadSource,
  ThreadSourceMetadata,
  ThreadTrustContext,
  UserCreditGrantType,
  AgentProviderMetadata,
  RepoSkillVersionSource,
} from "./types";
import {
  AutomationAction,
  AutomationTriggerType,
  AutomationTriggerConfig,
} from "../automations";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  // admin plugin fields
  role: text("role"),
  banned: boolean("banned"),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  // Shadow ban limits task creation rate without blocking access
  shadowBanned: boolean("shadow_banned").notNull().default(false),
  stripeCustomerId: text("stripe_customer_id"),
  signupTrialPlan: text("signup_trial_plan"),
});

export const userStripePromotionCode = pgTable(
  "user_stripe_promotion_code",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    stripeCouponId: text("stripe_coupon_id").notNull(),
    stripePromotionCodeId: text("stripe_promotion_code_id").notNull(),
    code: text("code").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    redeemedAt: timestamp("redeemed_at"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("user_stripe_promotion_code_user_unique").on(table.userId),
    uniqueIndex("user_stripe_promotion_code_code_unique").on(table.code),
    uniqueIndex("user_stripe_promotion_code_promo_unique").on(
      table.stripePromotionCodeId,
    ),
  ],
);

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  impersonatedBy: text("impersonated_by"), // admin plugin field
  // organization plugin field: request-time tenant selector. Everything
  // org-scoped keys off this. Nullable — a session may have no active org.
  activeOrganizationId: text("active_organization_id"),
});

// ---------------------------------------------------------------------------
// Better Auth `organization` plugin tables (tenant boundary).
// Columns mirror the plugin's expected schema (better-auth@1.3.25). The plugin
// manages these rows via its API; this is the Drizzle mapping drizzle-kit push
// applies. See docs/adr/ADR-001-tenant-scoping-enforcement.md.
// ---------------------------------------------------------------------------
export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: timestamp("created_at").notNull(),
  metadata: text("metadata"),
});

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    index("member_organization_id_idx").on(table.organizationId),
    index("member_user_id_idx").on(table.userId),
    uniqueIndex("member_org_user_unique").on(
      table.organizationId,
      table.userId,
    ),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at").notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organization_id_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
);

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

export const apikey = pgTable("apikey", {
  id: text("id").primaryKey(),
  name: text("name"),
  start: text("start"),
  prefix: text("prefix"),
  key: text("key").notNull(),
  // better-auth 1.5 renamed the api-key owner column `userId` -> `referenceId`
  // and added `configId` (defaults to "default"). The plugin only ever
  // references users here, so the FK to user.id is preserved.
  referenceId: text("reference_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  configId: text("config_id").notNull().default("default"),
  refillInterval: integer("refill_interval"),
  refillAmount: integer("refill_amount"),
  lastRefillAt: timestamp("last_refill_at"),
  enabled: boolean("enabled").default(true),
  rateLimitEnabled: boolean("rate_limit_enabled").default(true),
  rateLimitTimeWindow: integer("rate_limit_time_window").default(86400000),
  rateLimitMax: integer("rate_limit_max").default(10),
  requestCount: integer("request_count"),
  remaining: integer("remaining"),
  lastRequest: timestamp("last_request"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  permissions: text("permissions"),
  metadata: text("metadata"),
  // Tenant fence (WI-5 step 2). Nullable during additive/backfill phase. The
  // daemon-token resolver still reads organizationId from `metadata` today; this
  // typed column is the target the resolver switches to once keys are re-stamped.
  organizationId: text("organization_id").references(() => organization.id, {
    onDelete: "cascade",
  }),
});

export type SubscriptionStatus =
  | "active"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "past_due"
  | "paused"
  | "trialing"
  | "unpaid";

export const subscription = pgTable(
  "subscription",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    plan: text("plan").notNull(),
    referenceId: text("reference_id").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    status: text("status")
      .$type<SubscriptionStatus>()
      .notNull()
      .default("incomplete"),
    periodStart: timestamp("period_start"),
    periodEnd: timestamp("period_end"),
    trialStart: timestamp("trial_start"),
    trialEnd: timestamp("trial_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    seats: integer("seats").default(1),
    // Tenant fence (WI-5 step 2). Org-level billing: referenceId flips from
    // user.id to organizationId in a later phase; this column is the seam.
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("subscription_reference_id_idx").on(table.referenceId),
    index("subscription_status_idx").on(table.status),
    index("subscription_stripe_subscription_id_idx").on(
      table.stripeSubscriptionId,
    ),
    index("subscription_organization_id_idx").on(table.organizationId),
  ],
);

export const waitlist = pgTable(
  "waitlist",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text("email").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("email_unique").on(table.email)],
);

export const onboardingQuestionnaire = pgTable(
  "onboarding_questionnaire",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text("email").notNull(),
    claudeSubscription: text("claude_subscription"),
    participationPreference: text("participation_preference"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Keep old columns for backwards compatibility during migration
    primaryUseDeprecated: text("primary_use"),
    feedbackWillingnessDeprecated: text("feedback_willingness"),
    interviewWillingnessDeprecated: text("interview_willingness"),
  },
  (table) => [uniqueIndex("onboarding_email_unique").on(table.email)],
);

export const allowedSignups = pgTable(
  "allowed_signup",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text("email").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("allowed_signups_email_unique").on(table.email)],
);

const threadChatShared = {
  agent: text("agent").$type<AIAgent>().notNull().default("claudeCode"),
  agentVersion: integer("agent_version").notNull().default(0),
  status: text("status").$type<ThreadStatus>().notNull().default("queued"),
  messages: jsonb("messages").$type<DBMessage[]>(),
  queuedMessages: jsonb("queued_messages").$type<DBUserMessage[]>(),
  sessionId: text("session_id"),
  errorMessage: text("error_message").$type<ThreadErrorMessage>(),
  errorMessageInfo: text("error_message_info"),
  scheduleAt: timestamp("schedule_at"),
  reattemptQueueAt: timestamp("reattempt_queue_at"),
  contextLength: integer("context_length"),
  permissionMode: text("permission_mode")
    .$type<"allowAll" | "plan">()
    .default("allowAll"),
};

export const thread = pgTable(
  "thread",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Tenant fence (WI-5 step 2). Nullable during the additive/backfill phase;
    // tightened to NOT NULL after the backfill + query sweep (ADR-001 step 5).
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    name: text("name"),
    githubRepoFullName: text("github_repo_full_name").notNull(),
    repoBaseBranchName: text("repo_base_branch_name").notNull(),
    branchName: text("current_branch_name"),
    githubPRNumber: integer("github_pr_number"),
    githubIssueNumber: integer("github_issue_number"),
    codesandboxId: text("codesandbox_id"),
    // #114: NON-secret credential-broker provenance for the current sandbox.
    // "brokered" = the sandbox was created with a per-run credential broker
    // (Docker only); resume must fail closed and recreate. null/"legacy-direct"
    // = today's raw-token behavior. Never stores the token or bearer.
    credentialBrokerMode: text("credential_broker_mode").$type<
      "brokered" | "legacy-direct"
    >(),
    sandboxProvider: text("sandbox_provider")
      .notNull()
      .$type<SandboxProvider>()
      .default("e2b"),
    /**
     * The Hatchet workflow-run externalId of this thread's ACTIVE (latest
     * dispatched, not-yet-terminal) remote run (#125/#127). Written at
     * dispatch when the supersedePolicy flag is ON; consumed by the C1
     * generation fence: a terminal/verdict write from a run whose externalId
     * no longer matches is rejected 409 (superseded). NULL = no fenced run
     * (legacy dispatch, in-process sandbox) → the fence FAILS OPEN.
     */
    activeRunExternalId: text("active_run_external_id"),
    /**
     * Typed terminal cause (#125 C4): WHY a remote review run ended, written
     * exactly once by the worker's terminal post or the supersede sweep.
     * One of `TERMINAL_CAUSES` (model/terminal-cause.ts). NULL = no typed
     * terminal (normal completion, or a legacy/in-process run). Read by the
     * generation fence (any typed terminal refuses late writes) and by the
     * thread-view chips (C5).
     */
    terminalCause: text("terminal_cause"),
    /**
     * #125 C5: the PR head SHA this run reviews — stamped at thread creation
     * from the SAME `pulls.get` read that resolved the head branch; never
     * re-read from GitHub later. The recheck reconciliation compares it to
     * the durable desired head. NULL for non-PR threads.
     */
    reviewedSha: text("reviewed_sha"),
    /**
     * #125 C5: when `terminalCause = 'superseded'`, the thread of the newer
     * run that took over — what the "Superseded" chip links to. Best-effort.
     */
    supersededByThreadId: text("superseded_by_thread_id"),
    sandboxSize: text("sandbox_size").$type<SandboxSize>(),
    sandboxStatus: text("sandbox_status").$type<SandboxStatus>(),
    bootingSubstatus: text("booting_substatus").$type<BootingSubstatus>(),
    gitDiff: text("git_diff"),
    gitDiffStats: jsonb("git_diff_stats").$type<GitDiffStats>(),
    archived: boolean("archived").notNull().default(false),
    // Shadow-mode task (pilot): created from a shadow-mode installation —
    // ingested + visible in the dashboard, but NO sandbox boot and NO GitHub side
    // effects. The UI badges it. Defaults false (normal task).
    shadow: boolean("shadow").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    automationId: text("automation_id").references(
      (): AnyPgColumn => automations.id,
      { onDelete: "set null" },
    ),
    parentThreadId: text("parent_thread_id").references(
      (): AnyPgColumn => thread.id,
      { onDelete: "set null" },
    ),
    parentToolId: text("parent_tool_id"),
    draftMessage: jsonb("draft_message").$type<DBUserMessage>(),
    disableGitCheckpointing: boolean("disable_git_checkpointing")
      .notNull()
      .default(false),
    skipSetup: boolean("skip_setup").notNull().default(false),
    sourceType: text("source_type").$type<ThreadSource>(),
    sourceMetadata: jsonb("source_metadata").$type<ThreadSourceMetadata>(),
    /**
     * Server-derived PR trust snapshot (ADR-005 §3a) — `isFork` +
     * `authorAssociation` captured ONCE at intake from `pulls.get`, never from
     * caller/webhook input. NULL means "no snapshot" (non-PR thread, or an
     * intake-time GitHub lookup failure) and the permission-floor resolver MUST
     * treat NULL as fail-closed (cap = "review"), never as trusted. Kept as its
     * own column rather than folded into `sourceMetadata` — that field is a
     * discriminated union `automation-skill` promotion already occupies.
     */
    trustContext: jsonb("trust_context").$type<ThreadTrustContext>(),
    // Thread version:
    // 0: One thread -> chat information is part of the thread
    // 1: One thread -> can have multiple thread chats, chat information is separate from the thread
    version: integer("version").notNull().default(0),
    ...threadChatShared,
  },
  (table) => [
    index("user_id_index").on(table.userId),
    index("user_id_created_at_index").on(table.userId, table.createdAt),
    index("user_id_updated_at_index").on(table.userId, table.updatedAt),
    index("user_id_status_index").on(table.userId, table.status),
    index("user_id_archived_index").on(table.userId, table.archived),
    // Tenant-scoped access paths (WI-5). Mirror the user_id_* composites so the
    // forTenant accessor's and(organizationId, userId) reads stay index-covered.
    index("org_id_index").on(table.organizationId),
    index("org_id_user_id_index").on(table.organizationId, table.userId),
    index("org_id_user_id_created_at_index").on(
      table.organizationId,
      table.userId,
      table.createdAt,
    ),
    index("org_id_user_id_updated_at_index").on(
      table.organizationId,
      table.userId,
      table.updatedAt,
    ),
    index("org_id_user_id_status_index").on(
      table.organizationId,
      table.userId,
      table.status,
    ),
    index("org_id_user_id_archived_index").on(
      table.organizationId,
      table.userId,
      table.archived,
    ),
    index("parent_thread_id_index").on(table.parentThreadId),
    index("user_id_automation_id_index").on(table.userId, table.automationId),
    index("github_repo_full_name_github_pr_number_index").on(
      table.githubRepoFullName,
      table.githubPRNumber,
    ),
    index("schedule_at_status_index").on(table.scheduleAt, table.status),
    index("reattempt_queue_at_status_index").on(
      table.reattemptQueueAt,
      table.status,
    ),
    index("source_type_index").on(table.sourceType),
    index("sandbox_provider_and_id_index").on(
      table.sandboxProvider,
      table.codesandboxId,
    ),
  ],
);

export const threadChat = pgTable(
  "thread_chat",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    // Tenant fence (WI-5 step 2). Nullable; inherits its thread's org on backfill.
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    title: text("title"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    ...threadChatShared,
  },
  (table) => [
    index("thread_chat_user_id_thread_id_index").on(
      table.userId,
      table.threadId,
    ),
    index("thread_chat_org_id_index").on(table.organizationId),
  ],
);

export const threadVisibility = pgTable(
  "thread_visibility",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    threadId: text("thread_id")
      .notNull()
      .unique()
      .references(() => thread.id, {
        onDelete: "cascade",
      }),
    visibility: text("visibility").$type<ThreadVisibility>().notNull(),
    // Tenant fence (WI-5 step 2). Nullable; inherits its thread's org on backfill.
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("thread_visibility_thread_id_index").on(table.threadId),
    index("thread_visibility_org_id_index").on(table.organizationId),
  ],
);

export const githubPR = pgTable(
  "github_pr",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    repoFullName: text("repo_full_name").notNull(),
    number: integer("number").notNull(),
    status: text("status").$type<GithubPRStatus>().notNull().default("open"),
    baseRef: text("base_ref"),
    mergeableState: text("mergeable_state")
      .$type<GithubPRMergeableState>()
      .default("unknown"),
    checksStatus: text("checks_status")
      .$type<GithubCheckStatus>()
      .default("unknown"),
    threadId: text("thread_id").references(() => thread.id, {
      onDelete: "set null",
    }),
    // NO organizationId (WI-5 batch 3a, ADR-001 follow-up decision): github_pr is
    // a GLOBAL mirror of GitHub's PR state (status/refs/mergeable/checks) — one PR
    // on GitHub is one state, not tenant data. Tenant isolation lives on the
    // THREAD (thread.organizationId + getThreadForGithubPRAndUser's fence), so
    // repo_number_unique stays (repo, number) and no per-org row exists. This
    // supersedes the step-2 speculative organizationId column: a mirror of
    // external state is not something a single org can own.
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("repo_number_unique").on(table.repoFullName, table.number),
  ],
);

export const githubCheckRun = pgTable(
  "github_check_run",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    threadId: text("thread_id").references(() => thread.id, {
      onDelete: "set null",
    }),
    threadChatId: text("thread_chat_id").references(() => threadChat.id, {
      onDelete: "set null",
    }),
    checkRunId: bigint("check_run_id", { mode: "number" }).notNull(),
    status: text("status")
      .$type<GithubCheckRunStatus>()
      .notNull()
      .default("queued"),
    conclusion: text("conclusion").$type<GithubCheckRunConclusion>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("thread_id_thread_chat_id_unique").on(
      table.threadId,
      table.threadChatId,
    ),
  ],
);

// Maps a GitHub App installation to an org (WI-5). Parallels slackInstallation:
// the tenant boundary for GitHub — one installation per customer org (the
// orch-agents prod model). Nullable-safe: an unmapped installation → null org,
// so a GitHub mention creates a thread without an org (today's behavior).
export const githubInstallation = pgTable(
  "github_installation",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    installationId: text("installation_id").notNull().unique(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    // Shadow-mode pilot gate (pilot): 'shadow' = ingest + create task
    // rows (org-stamped), NO sandbox boot, NO GitHub side effects — proves E2E
    // with zero footprint on a live PR (two bots must never act on one PR).
    // 'active' behaves as today. New bindings default to 'shadow'.
    mode: text("mode").$type<"shadow" | "active">().notNull().default("shadow"),
    accountLogin: text("account_login"),
    accountType: text("account_type"), // "Organization" | "User"
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("github_installation_org_id_index").on(table.organizationId),
  ],
);

export const userSettings = pgTable(
  "user_settings",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // This setting is now deprecated. It is always true.
    autoPushBranches: boolean("auto_push_branches").notNull().default(false),
    autoCreatePRs: boolean("auto_create_draft_prs").notNull().default(true),
    autoArchiveMergedPRs: boolean("auto_archive_merged_prs")
      .notNull()
      .default(true),
    autoClosePRsOnArchive: boolean("auto_close_draft_prs_on_archive")
      .notNull()
      .default(false),
    branchNamePrefix: text("branch_name_prefix").notNull().default("terragon/"),
    prType: text("pr_type")
      .$type<"draft" | "ready">()
      .notNull()
      .default("draft"),
    sandboxProvider: text("sandbox_provider")
      .$type<SandboxProvider | "default">()
      .notNull()
      .default("default"),
    sandboxSize: text("sandbox_size").$type<SandboxSize>(),
    customSystemPrompt: text("custom_system_prompt"),
    defaultThreadVisibility: text("default_thread_visibility")
      .$type<ThreadVisibility>()
      .notNull()
      .default("repo"),
    // Opt-in to early Preview features
    previewFeaturesOptIn: boolean("preview_features_opt_in")
      .notNull()
      .default(false),
    singleThreadForGitHubMentions: boolean("single_thread_for_github_mentions")
      .notNull()
      .default(true),
    defaultGitHubMentionModel: text(
      "default_github_mention_model",
    ).$type<AIModel>(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    autoReloadDisabled: boolean("auto_reload_disabled")
      .notNull()
      .default(false),
    agentModelPreferences: jsonb(
      "agent_model_preferences",
    ).$type<AgentModelPreferences>(),
  },
  (table) => [uniqueIndex("user_id_unique").on(table.userId)],
);

// Each user + repo combination has an environment.
export const environment = pgTable(
  "environment",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Tenant fence (WI-5 step 2). Nullable; the user_id_repo_full_name unique
    // index becomes (organization_id, repo) when tightened (ADR-001 step 5).
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    isGlobal: boolean("is_global").notNull().default(false),
    repoFullName: text("repo_full_name").notNull(),
    environmentVariables: jsonb("environment_variables")
      .$type<Array<{ key: string; valueEncrypted: string }>>()
      .default([]),
    mcpConfigEncrypted: text("mcp_config_encrypted"),
    setupScript: text("setup_script"),
    DEPRECATED_disableGitCheckpointing: boolean("disable_git_checkpointing")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("user_id_repo_full_name_branch_name_unique").on(
      table.userId,
      table.repoFullName,
    ),
    index("environment_org_id_index").on(table.organizationId),
    // Serves getEnvironments' org-fenced list read (WHERE user_id AND org).
    index("environment_user_id_org_id_index").on(
      table.userId,
      table.organizationId,
    ),
  ],
);

// Deprecated: UNUSED - replaced by agent_provider_credentials table
export const claudeOAuthTokens_DEPRECATED = pgTable("claude_oauth_tokens", {
  id: text("id")
    .default(sql`gen_random_uuid()`)
    .primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" })
    .unique(), // One token per user
  isSubscription: boolean("is_subscription").notNull().default(true),
  anthropicApiKeyEncrypted: text("anthropic_api_key_encrypted"),
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  tokenType: text("token_type").notNull(),
  expiresAt: timestamp("expires_at", { mode: "date" }), // Calculated from expires_in
  refreshTokenEncrypted: text("refresh_token_encrypted"),
  scope: text("scope"),
  isMax: boolean("is_max").default(false).notNull(), // Cache Claude Max status
  organizationType: text("organization_type").$type<ClaudeOrganizationType>(),
  accountId: text("account_id"),
  accountEmail: text("account_email"),
  orgId: text("org_id"),
  orgName: text("org_name"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

// Deprecated: UNUSED - replaced by agent_provider_credentials table
export const geminiAuth_DEPRECATED = pgTable("gemini_auth", {
  id: text("id")
    .default(sql`gen_random_uuid()`)
    .primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" })
    .unique(), // One token per user
  tokenType: text("token_type").$type<"oauth" | "apiKey">().notNull(),
  geminiApiKeyEncrypted: text("gemini_api_key_encrypted"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

// Deprecated: UNUSED - replaced by agent_provider_credentials table
export const ampAuth_DEPRECATED = pgTable("amp_auth", {
  id: text("id")
    .default(sql`gen_random_uuid()`)
    .primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" })
    .unique(), // One token per user
  ampApiKeyEncrypted: text("amp_api_key_encrypted"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

// Deprecated: UNUSED - replaced by agent_provider_credentials table
export const openAIAuth_DEPRECATED = pgTable("openai_auth", {
  id: text("id")
    .default(sql`gen_random_uuid()`)
    .primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" })
    .unique(), // One token per user
  openAIApiKeyEncrypted: text("openai_api_key_encrypted"),
  // OAuth tokens for Codex credentials
  accessTokenEncrypted: text("access_token_encrypted"),
  refreshTokenEncrypted: text("refresh_token_encrypted"),
  idTokenEncrypted: text("id_token_encrypted"),
  accountId: text("account_id"),
  expiresAt: timestamp("expires_at", { mode: "date" }),
  lastRefreshedAt: timestamp("last_refreshed_at", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const slackInstallation = pgTable(
  "slack_installation",
  {
    id: text("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    teamId: text("team_id").notNull().unique(), // Slack workspace ID
    // Tenant fence (WI-5 step 2). Nullable; a Slack workspace maps to an org so
    // mentions route to the right tenant once backfilled.
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    teamName: text("team_name").notNull(),
    botUserId: text("bot_user_id").notNull(), // Bot user ID for mentions
    botAccessTokenEncrypted: text("bot_access_token_encrypted").notNull(), // xoxb- token
    scope: text("scope").notNull(), // Bot scopes (app_mentions:read, chat:write, etc.)
    appId: text("app_id").notNull(),
    installerUserId: text("installer_user_id"), // Slack user who installed
    isEnterpriseInstall: boolean("is_enterprise_install")
      .default(false)
      .notNull(),
    enterpriseId: text("enterprise_id"),
    enterpriseName: text("enterprise_name"),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("slack_installation_team_id").on(table.teamId),
    index("slack_installation_org_id_index").on(table.organizationId),
  ],
);

export const slackAccount = pgTable(
  "slack_account",
  {
    id: text("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    slackUserId: text("slack_user_id").notNull().unique(),
    slackTeamName: text("slack_team_name").notNull(),
    slackTeamDomain: text("slack_team_domain").notNull(),
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("slack_account_user_team_unique").on(
      table.userId,
      table.teamId,
    ),
    uniqueIndex("slack_account_slack_user_team_unique").on(
      table.slackUserId,
      table.teamId,
    ),
  ],
);

export const slackSettings = pgTable(
  "slack_settings",
  {
    id: text("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    defaultRepoFullName: text("default_repo_full_name"),
    defaultModel: text("default_model").$type<AIModel>(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("slack_settings_user_team_unique").on(
      table.userId,
      table.teamId,
    ),
  ],
);

export const threadReadStatus = pgTable(
  "thread_read_status",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    isRead: boolean("is_read").notNull().default(true),
    lastReadAt: timestamp("last_read_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_thread_unique").on(table.threadId, table.userId),
  ],
);

export const threadChatReadStatus = pgTable(
  "thread_chat_read_status",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    threadChatId: text("thread_chat_id")
      .notNull()
      .references(() => threadChat.id, { onDelete: "cascade" }),
    isRead: boolean("is_read").notNull().default(true),
    lastReadAt: timestamp("last_read_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("user_thread_chat_thread_id_user_id_index").on(
      table.threadId,
      table.userId,
    ),
    uniqueIndex("user_thread_chat_unique").on(
      table.userId,
      table.threadId,
      table.threadChatId,
    ),
  ],
);

export const feedback = pgTable(
  "feedback",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: text("type").$type<"bug" | "feature" | "feedback">().notNull(),
    message: text("message").notNull(),
    currentPage: text("current_page").notNull(),
    resolved: boolean("resolved").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("feedback_user_id_index").on(table.userId),
    index("feedback_type_index").on(table.type),
    index("feedback_resolved_index").on(table.resolved),
  ],
);

export const userFlags = pgTable(
  "user_flags",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    hasSeenOnboarding: boolean("has_seen_onboarding").notNull().default(false),
    showDebugTools: boolean("show_debug_tools").notNull().default(false),
    isClaudeMaxSub: boolean("is_claude_max_sub").notNull().default(false),
    isClaudeSub: boolean("is_claude_sub").notNull().default(false),
    claudeOrganizationType: text(
      "claude_organization_type",
    ).$type<ClaudeOrganizationType>(),
    selectedModel: text("selected_model").$type<AIModel>(),
    selectedModels: jsonb("selected_models").$type<SelectedAIModels>(),
    multiAgentMode: boolean("multi_agent_mode").notNull().default(false),
    selectedRepo: text("selected_repo"),
    selectedBranch: text("selected_branch"),
    // @deprecated Use lastSeenReleaseNotesVersion instead
    lastSeenReleaseNotes: timestamp("last_seen_release_notes"),
    lastSeenReleaseNotesVersion: integer("last_seen_release_notes_version"),
    // Feature upsell toast last seen version. Increment FEATURE_UPSELL_VERSION
    // in apps/www/src/lib/constants.ts to show the upsell again.
    lastSeenFeatureUpsellVersion: integer("last_seen_feature_upsell_version"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("user_flags_user_id_unique").on(table.userId)],
);

// This table is used to store user info that is only available on the server side.
export const userInfoServerSide = pgTable(
  "user_info_server_side",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    autoReloadLastAttemptAt: timestamp("auto_reload_last_attempt_at"),
    autoReloadLastFailureAt: timestamp("auto_reload_last_failure_at"),
    autoReloadLastFailureCode: text("auto_reload_last_failure_code"),
    stripeCreditPaymentMethodId: text("stripe_credit_payment_method_id"),
  },
  (table) => [
    uniqueIndex("user_info_server_side_user_id_unique").on(table.userId),
  ],
);

export const featureFlags = pgTable(
  "feature_flags",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    defaultValue: boolean("default_value").notNull(),
    globalOverride: boolean("global_override"),
    description: text("description"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("name_unique").on(table.name)],
);

export const userFeatureFlags = pgTable(
  "user_feature_flags",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    featureFlagId: text("feature_flag_id")
      .notNull()
      .references(() => featureFlags.id, { onDelete: "cascade" }),
    value: boolean("value").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_id_feature_flag_id_unique").on(
      table.userId,
      table.featureFlagId,
    ),
  ],
);

export const accessCodes = pgTable(
  "access_codes",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    code: text("code").notNull(),
    email: text("email"), // Optional: specific email this code is for
    usedByEmail: text("used_by_email"), // Optional: email of the user who used the code
    usedAt: timestamp("used_at"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("access_code_unique").on(table.code),
    index("access_codes_expires_at_index").on(table.expiresAt),
    index("access_codes_created_by_user_id_index").on(table.createdByUserId),
  ],
);

export const reengagementEmails = pgTable(
  "reengagement_emails",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text("email").notNull(),
    accessCodeId: text("access_code_id")
      .notNull()
      .references(() => accessCodes.id, { onDelete: "cascade" }),
    sentAt: timestamp("sent_at").notNull().defaultNow(),
    sentByUserId: text("sent_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("reengagement_email_access_code_unique").on(
      table.email,
      table.accessCodeId,
    ),
    index("reengagement_emails_email_index").on(table.email),
    index("reengagement_emails_sent_at_index").on(table.sentAt),
  ],
);

export const onboardingCompletionEmails = pgTable(
  "onboarding_completion_emails",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    sentAt: timestamp("sent_at").notNull().defaultNow(),
    sentByUserId: text("sent_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("onboarding_completion_email_user_unique").on(table.userId),
    index("onboarding_completion_emails_sent_at_index").on(table.sentAt),
  ],
);

export const automations = pgTable(
  "automations",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Tenant fence (WI-5 step 2). Nullable; org-owned automations on backfill.
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(true),
    triggerType: text("trigger_type").$type<AutomationTriggerType>().notNull(),
    triggerConfig: jsonb("trigger_config")
      .$type<AutomationTriggerConfig>()
      .notNull(),
    repoFullName: text("repo_full_name").notNull(),
    branchName: text("branch_name").notNull(),
    action: jsonb("action").$type<AutomationAction>().notNull(),
    skipSetup: boolean("skip_setup").notNull().default(false),
    disableGitCheckpointing: boolean("disable_git_checkpointing")
      .notNull()
      .default(false),
    lastRunAt: timestamp("last_run_at"),
    nextRunAt: timestamp("next_run_at"),
    runCount: integer("run_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("automations_user_id_index").on(table.userId),
    index("automations_user_id_enabled_index").on(table.userId, table.enabled),
    index("automations_trigger_type_index").on(table.triggerType),
    index("automations_pull_request_repo_full_name_index").on(
      table.triggerType,
      table.repoFullName,
    ),
    index("automations_next_run_at_index").on(table.nextRunAt),
    index("automations_org_id_index").on(table.organizationId),
    // Serves getAutomations' org-fenced list read (WHERE user_id AND org).
    index("automations_user_id_org_id_index").on(
      table.userId,
      table.organizationId,
    ),
  ],
);

export const userCredits = pgTable(
  "user_credits",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    amountCents: integer("amount_cents").notNull(),
    description: text("description"),
    referenceId: text("reference_id"),
    grantType: text("grant_type").$type<UserCreditGrantType>(),
    // Tenant fence (WI-5 step 2). Nullable; credits become an org-pooled balance.
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("user_credits_user_id_index").on(table.userId),
    uniqueIndex("user_credits_reference_id_unique").on(table.referenceId),
    index("user_credits_org_id_index").on(table.organizationId),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    eventType: text("event_type").$type<UsageEventType>().notNull(),
    value: numeric("value").notNull(),
    sku: text("sku").$type<UsageSku>(),
    // Tokens that are billed at the normal input rate
    inputTokens: integer("input_tokens"),
    // Tokens that are billed at the cache hit rate
    cachedInputTokens: integer("cached_input_tokens"),
    // Tokens that are billed at the cache creation rate
    cacheCreationInputTokens: integer("cache_creation_input_tokens"),
    // Tokens that are billed at the output rate
    outputTokens: integer("output_tokens"),
    // Tenant fence (WI-5 step 2). Nullable; usage rolls up to the org (Hatchet
    // tenant billing) on backfill.
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("usage_events_user_id_index").on(table.userId),
    index("usage_events_org_id_index").on(table.organizationId),
    index("usage_events_user_id_created_at_index").on(
      table.userId,
      table.createdAt,
    ),
    index("usage_events_user_id_sku_index").on(table.userId, table.sku),
    // tail-scan & aggregation index
    index("usage_events_user_sku_type_ts_id_idx").on(
      table.userId,
      table.sku,
      table.eventType,
      table.createdAt,
      table.id,
    ),
  ],
);

/**
 * Stores running totals of usage per (user, sku, eventType),
 * plus a (created_at, id) watermark to allow incremental catch-ups.
 */
export const usageEventsAggCacheSku = pgTable(
  "usage_events_agg_cache_sku",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    // Tenant fence (WI-5 step 2). Nullable; matches usageEvents rollup on backfill.
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    sku: text("sku").$type<UsageSku>().notNull(),
    eventType: text("event_type").$type<UsageEventType>().notNull(),
    inputTokens: bigint("input_tokens", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    cachedInputTokens: bigint("cached_input_tokens", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    cacheCreationInputTokens: bigint("cache_creation_input_tokens", {
      mode: "bigint",
    })
      .notNull()
      .default(sql`0`),
    outputTokens: bigint("output_tokens", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    lastUsageTs: timestamp("last_usage_ts", { withTimezone: true }),
    lastUsageId: text("last_usage_id").references(() => usageEvents.id, {
      onDelete: "cascade",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // unique per (user, sku, event_type)
    uniqueIndex("usage_events_agg_cache_sku_user_sku_event_type_unique").on(
      t.userId,
      t.sku,
      t.eventType,
    ),
    index("usage_events_agg_cache_sku_user_index").on(t.userId),
    index("usage_events_agg_cache_sku_user_sku_index").on(t.userId, t.sku),
    index("usage_events_agg_cache_sku_org_index").on(t.organizationId),
  ],
);

export const claudeSessionCheckpoints = pgTable(
  "claude_session_checkpoints",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    r2Key: text("r2_key").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("claude_session_unique").on(table.threadId, table.sessionId),
  ],
);

export const agentProviderCredentials = pgTable(
  "agent_provider_credentials",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Tenant fence (WI-5 step 2). Nullable = "user-personal vs org-shared" team
    // credentials; the null/non-null distinction is a real product decision, not
    // just a retrofit (ADR-001 follow-ups).
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    agent: text("agent").$type<AIAgent>().notNull(),
    // Plain `text` + a TS union: no PG enum, no CHECK, so widening this is a pure
    // TypeScript change with no migration. See model/credential-kind.ts for what
    // each kind means to the UI — and for why that mapping is a Record the
    // compiler can check rather than ternaries scattered across consumers.
    type: text("type").$type<CredentialKind>().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    apiKeyEncrypted: text("api_key_encrypted"),
    accessTokenEncrypted: text("access_token_encrypted"),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    idTokenEncrypted: text("id_token_encrypted"),
    expiresAt: timestamp("expires_at", { mode: "date" }),
    lastRefreshedAt: timestamp("last_refreshed_at", { mode: "date" }),
    metadata: jsonb("metadata").$type<AgentProviderMetadata>(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("agent_provider_credentials_user_id_index").on(table.userId),
    index("agent_provider_credentials_user_agent_index").on(
      table.userId,
      table.agent,
    ),
    index("agent_provider_credentials_org_id_index").on(table.organizationId),
    // Serves the org-fenced credential reads (WHERE user_id AND org [AND agent]):
    // getAllAgentProviderCredentialRecords, getAgentProviderCredentialsRecord.
    index("agent_provider_credentials_user_org_agent_index").on(
      table.userId,
      table.organizationId,
      table.agent,
    ),
  ],
);

/**
 * Per-repository REQUESTED_CHANGES severity tolerance (ADR-036 review floor).
 *
 * An operator-selectable floor deciding at which finding severity a PR review's
 * verdict is forced to `request_changes`: `error` (only error/critical block),
 * `warning` (the default when no row exists), or `info` (every finding blocks).
 * Resolved LIVE per dispatched review run (no restart) and applied server-side
 * by `applyApproveSeverityFloor`, so it is the single source of truth for the
 * external PR verdict floor.
 *
 * MULTI-TENANT: scoped to `(organizationId, repoFullName)` — the same repo slug
 * reviewed under two different orgs carries two independent tolerances, never a
 * cross-tenant bleed. `organizationId` is the tenant fence; the unique index on
 * the pair makes the store an upsert. `updatedByUserId` records provenance for
 * the audit trail. Distinct from the deterministic ReviewGate's internal quality
 * bar, which deliberately does NOT follow this per-repo setting.
 */
export const repoReviewSettings = pgTable(
  "repo_review_settings",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Lowercased 'owner/name' slug — GitHub slugs are case-insensitive. */
    repoFullName: text("repo_full_name").notNull(),
    /** 'info' | 'warning' | 'error' — the lowest severity that blocks. */
    blockTolerance: text("block_tolerance").notNull().default("warning"),
    /**
     * Whether Automata engages DRAFT pull requests for this repo. Default true —
     * Automata works on drafts by default; an operator sets this false to have it
     * ignore drafts until they are marked ready. Enforced at the webhook intake
     * gate, so a draft-skipped PR never dispatches a run at all.
     */
    reviewDraftPrs: boolean("review_draft_prs").notNull().default(true),
    /**
     * Author-trust threshold `T` (an `author_association` trust rank:
     * OWNER > MEMBER > COLLABORATOR > CONTRIBUTOR > FIRST_TIME_CONTRIBUTOR > NONE)
     * for this repo, per ADR-005 §4. Nullable, no column default — absent means
     * "no repo override" and the resolver falls back to the org floor / the
     * `MEMBER` default. Raw string here (dependency-free from `@terragon/review`),
     * validated at the apps/www boundary. A repo may only *raise* this above the
     * org floor `T_org` (`T_eff = max(T_org, T_repo)`), enforced by the resolver,
     * not this column.
     */
    trustedAuthorThreshold: text("trusted_author_threshold"),
    /**
     * Egress enforcement level for runs on this repo (#66):
     * 'none' | 'ip_port' | 'domain'. NULL (the default) = no enforcement —
     * today's behavior, so absent policy is a structural no-regression. Raw
     * string here (dependency-free); validated to `EgressPolicyLevel` when the
     * shape is built (`model/egress-policy.ts`).
     */
    egressPolicy: text("egress_policy"),
    /**
     * Operator allowlist entries for the level above: `host` or `host:port`
     * (`ip_port` level: IP or IP:port; `domain` level: domain or `*.domain`
     * wildcard). System hosts (callback, github.com, api.anthropic.com) are
     * merged in at shape-build time, NOT stored here.
     */
    egressAllowlist: text("egress_allowlist").array(),
    /**
     * Supersede policy for PR-review runs on this (org, repo) (#125/#127):
     * what happens when a new commit lands while a review run is still in
     * flight on the same PR. One of 'newest-wins' | 'complete-run-queue' |
     * 'complete-run-discard' | 'app-side'. NULL (default) = no explicit
     * choice → the resolver falls back to the org-default row (sentinel repo
     * '*') and finally to 'newest-wins'. Raw string here (dependency-free);
     * validated at the write boundary AND at dispatch — an unknown stored
     * value THROWS at dispatch, never degrades silently.
     */
    supersedePolicy: text("supersede_policy"),
    /**
     * Under 'complete-run-discard' only (#125 design D3): when the surviving
     * run finishes, re-dispatch one review at the PR's CURRENT head if newer
     * commits were discarded mid-run. Default false — discard means discard.
     */
    recheckOnComplete: boolean("recheck_on_complete").notNull().default(false),
    /** Provenance: the user who last wrote this override (audit trail). */
    updatedByUserId: text("updated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One tolerance per (org, repo) — the upsert conflict target + live-read key.
    uniqueIndex("repo_review_settings_org_repo_index").on(
      table.organizationId,
      table.repoFullName,
    ),
    index("repo_review_settings_org_id_index").on(table.organizationId),
  ],
);

/**
 * Per-organization review-settings floor (ADR-005 §4): `blockTolerance` and
 * `trustedAuthorThreshold` set here are the ORG FLOOR — the most permissive
 * value a repo under this org may configure. A repo may only narrow
 * `blockTolerance` and only *raise* `trustedAuthorThreshold` relative to this
 * row (`T_eff = max(T_org, T_repo)`), composed by the same monotone
 * combinator described in ADR-005. Both columns are nullable with NO default:
 * an absent row (or absent column) means "no org floor configured" — today's
 * behavior is unchanged until an org explicitly sets one. The "default
 * T = MEMBER" from the owner ruling is a RESOLVER default (tickets #72/#73),
 * never a column default here.
 *
 * MULTI-TENANT: `organizationId` is both the primary key and the tenant fence
 * — one row per org, looked up by PK alone (no repo slug in this table).
 * `updatedByUserId` records provenance for the audit trail, mirroring
 * `repoReviewSettings`.
 */
export const organizationReviewSettings = pgTable(
  "organization_review_settings",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * 'info' | 'warning' | 'error' — the org-wide floor for the lowest
     * severity that blocks. Nullable, no default: absent = no org floor =
     * today's per-repo-only behavior.
     */
    blockTolerance: text("block_tolerance"),
    /**
     * Author-trust threshold floor `T_org`. Stored values are the six GitHub
     * `author_association` ranks uppercase (OWNER | MEMBER | COLLABORATOR |
     * CONTRIBUTOR | FIRST_TIME_CONTRIBUTOR | NONE). Nullable, no default —
     * see `repoReviewSettings.trustedAuthorThreshold` doc for the same note.
     */
    trustedAuthorThreshold: text("trusted_author_threshold"),
    /** Provenance: the user who last wrote this override (audit trail). */
    updatedByUserId: text("updated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

/**
 * Per-dispatch tracking of the Hatchet `agent-run` externalId (enterprise-hardening
 * #8 supersede). One row per remote dispatch. When a NEW PR-review run is dispatched
 * for a PR that already has a live `in_flight` review run, dispatch cancels the prior
 * run by its `externalId` and marks that row `superseded` — so only the newest verdict
 * posts. Mentions never supersede, so only review dispatches write rows here.
 *
 * MULTI-TENANT: every read/write is fenced by `organizationId`; the same repo slug
 * under two orgs never collides. `repoFullName` is lowercased (case-insensitive GitHub
 * slugs), matching `repoReviewSettings`.
 *
 * Rows are NOT eagerly marked finished — the supersede finder only considers rows
 * within a freshness window (≈ the 75m stalled-cutoff), so a long-completed run is
 * never a cancel target. Growth is bounded by an age-based prune: the hourly
 * stalled-tasks cron deletes rows older than HATCHET_RUN_PRUNE_AFTER_MS via
 * pruneHatchetRuns (see model/hatchet-run.ts).
 */
/**
 * Live, versioned review/agent skills per (org, repo, skill) — the DB tier of
 * the hybrid skill store (issue #54). Today the github-ops methodology is
 * INLINED into the automation's action jsonb at seed time, so an edit is dead
 * until an operator re-runs the seed script. This entity makes the skill body
 * first-class: the automation stores a REFERENCE (`skill_message` action) and
 * the control plane resolves the current version at thread creation, so an
 * accepted edit is live on the next run — no seed, no redeploy.
 *
 * MULTI-TENANT: fenced by `organizationId` exactly like `repoReviewSettings`;
 * the same repo slug under two orgs carries independent skills. `repoFullName`
 * is lowercased on write and read (case-insensitive GitHub slugs).
 *
 * `currentVersionId` is the pointer edits move (append-only versions, see
 * `repoSkillVersions`); `lastKnownGoodVersionId` is promoted after a version
 * demonstrably produced a healthy run, giving the resolver a safe fallback when
 * the current version is broken. Both are nullable `set null` references so
 * deleting a version can never orphan-block the skill row.
 */
export const repoSkills = pgTable(
  "repo_skills",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Lowercased 'owner/name' slug — GitHub slugs are case-insensitive. */
    repoFullName: text("repo_full_name").notNull(),
    /** Registry key, e.g. 'github-ops' | 'github-deep-research' | 'github-mention'. */
    skillName: text("skill_name").notNull(),
    /** The version the resolver serves for `version: "latest"` references. */
    currentVersionId: text("current_version_id").references(
      (): AnyPgColumn => repoSkillVersions.id,
      { onDelete: "set null" },
    ),
    /** Fallback promoted after a healthy run — never points at a known-bad body. */
    lastKnownGoodVersionId: text("last_known_good_version_id").references(
      (): AnyPgColumn => repoSkillVersions.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One skill row per (org, repo, name) — the resolver's live-read key.
    uniqueIndex("repo_skills_org_repo_skill_index").on(
      table.organizationId,
      table.repoFullName,
      table.skillName,
    ),
    index("repo_skills_org_id_index").on(table.organizationId),
  ],
);

/**
 * Append-only version history for `repoSkills`. An edit NEVER mutates a body:
 * it inserts a new row here and moves `repoSkills.currentVersionId` — so the
 * audit trail (who wrote what, from which surface) and rollback (revert = move
 * the pointer) are structural, not best-effort. `contentSha` is the sha256 of
 * the body, stamped into `thread.sourceMetadata` at resolution so any thread
 * can be traced to the exact skill text it ran with.
 */
export const repoSkillVersions = pgTable(
  "repo_skill_versions",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    skillId: text("skill_id")
      .notNull()
      .references(() => repoSkills.id, { onDelete: "cascade" }),
    /** The full skill body (markdown, frontmatter already stripped). */
    body: text("body").notNull(),
    /** sha256 hex of `body` — the traceability stamp. */
    contentSha: text("content_sha").notNull(),
    /** Which edit surface produced this version. */
    source: text("source").$type<RepoSkillVersionSource>().notNull(),
    /**
     * Upstream provenance for a `source: 'git-pack'` version: the exact
     * `owner/repo@<40-hex-sha>:<path>` the body was imported from at a PINNED
     * ref (parseGitPackRef requires all three parts, so the `:path` is always
     * present). Null for every other source. Additive/nullable — old rows are
     * unaffected.
     */
    sourceRef: text("source_ref"),
    /** Provenance: the user who wrote this version (audit trail). */
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("repo_skill_versions_skill_id_index").on(table.skillId)],
);

export const hatchetRun = pgTable(
  "hatchet_run",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** The thread this dispatch drives (its run is what gets cancelled/superseded). */
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Lowercased 'owner/name' slug — GitHub slugs are case-insensitive. */
    repoFullName: text("repo_full_name").notNull(),
    /** The PR under review — the supersede key is (org, repo, pr). */
    prNumber: integer("pr_number").notNull(),
    /** Hatchet workflow-run id (`run.metadata.id`) — the handle passed to cancel. */
    externalId: text("external_id").notNull(),
    /**
     * 'in_flight' at dispatch → 'superseded' when a newer review takes the PR
     * (app-side cancel, or the worker's/sweep's `superseded` terminal) →
     * 'terminal' for any other typed terminal (#125 C4: the CAUSE lives on
     * the thread; this status only says "no longer a supersede candidate").
     * A successfully completed run is never eagerly marked (the finder bounds
     * candidates by a freshness window instead).
     */
    status: text("status")
      .notNull()
      .$type<"in_flight" | "superseded" | "terminal">()
      .default("in_flight"),
    /**
     * #125 C4 sweep lease: a sweep tick claims a row by moving this past now()
     * (compare-and-set) before it inspects the engine or writes a terminal —
     * two concurrent ticks can never both act on one run. NULL = unclaimed.
     */
    sweepLeaseUntil: timestamp("sweep_lease_until", { mode: "date" }),
    /**
     * #125 C5: the policy SNAPSHOT stamped at dispatch (decision 5) — the
     * control-plane copy of what the run's input/metadata carry. The recheck
     * reconciliation reads THESE, never the current settings row. NULL on
     * legacy (flag-off) dispatches.
     */
    supersedePolicy: text("supersede_policy"),
    recheckOnComplete: boolean("recheck_on_complete"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // The live-supersede lookup key: find in_flight review runs for one PR.
    index("hatchet_run_org_repo_pr_index").on(
      table.organizationId,
      table.repoFullName,
      table.prNumber,
    ),
    index("hatchet_run_thread_id_index").on(table.threadId),
    // One row per Hatchet run; the generation fence, the worker terminal and
    // the staleness self-check all look rows up by externalId.
    uniqueIndex("hatchet_run_external_id_index").on(table.externalId),
  ],
);

/**
 * #125 C5 durable desired head: the newest PR head SHA seen for one
 * `prKey` (`${orgId}/${repo}/${prNumber}`), written by every pull_request
 * webhook with a compare-and-set on the GitHub timestamp (out-of-order
 * deliveries never move it backwards; ties break on the lexicographically
 * greater delivery id). The recheck reconciliation compares a finished run's
 * `thread.reviewedSha` against this.
 */
export const supersedeDesiredHead = pgTable("supersede_desired_head", {
  prKey: text("pr_key").primaryKey(),
  sha: text("sha").notNull(),
  /** The GitHub-side timestamp of the delivery that set this head. */
  webhookAt: timestamp("webhook_at", { mode: "date" }).notNull(),
  deliveryId: text("delivery_id").notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * #125 C5 recheck ledger: one row per (prKey, desiredHeadSha) that a
 * reconciliation re-dispatched for. The UNIQUE constraint IS the
 * exactly-once guarantee — at most one recheck per head, however many
 * terminals race to claim it.
 */
export const supersedeRecheck = pgTable(
  "supersede_recheck",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    prKey: text("pr_key").notNull(),
    desiredHeadSha: text("desired_head_sha").notNull(),
    /** The finished thread whose terminal triggered this recheck. */
    triggeredByThreadId: text("triggered_by_thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    dispatchedAt: timestamp("dispatched_at", { mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("supersede_recheck_pr_key_sha_index").on(
      table.prKey,
      table.desiredHeadSha,
    ),
  ],
);

/**
 * Egress audit sink (#66): one row per egress decision (allow AND deny) made
 * by an enforcement plane (worker proxy, Docker sidecar) or a single
 * "policy applied" marker from native-firewall planes (E2B/Daytona). Rows
 * arrive via the daemon-token-authed `/api/daemon/egress-event` route — the
 * planes never touch this table (composability invariant: planes learn the
 * `EgressPolicyShape` only, never table/model names).
 *
 * MULTI-TENANT: `organizationId` is the tenant fence for reads (org-fenced
 * list in `model/egress-events.ts`); nullable because a personal/no-org
 * thread still audits. Retention: rows are audit exhaust, not durable
 * billing data — the age-based `pruneEgressEvents` (same pattern as
 * `pruneHatchetRuns`) bounds table growth, so age is the only growth bound.
 */
export const egressEvents = pgTable(
  "egress_events",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),
    threadId: text("thread_id"),
    /** The per-run key the decision belongs to (the daemon token's run binding). */
    runId: text("run_id").notNull(),
    destinationHost: text("destination_host").notNull(),
    destinationPort: integer("destination_port"),
    /** 'allow' | 'deny' — every decision is audited, not only denies (AC3). */
    action: text("action").$type<"allow" | "deny">().notNull(),
    /** The policy level in force when the decision was made ('none'|'ip_port'|'domain'). */
    policyLevel: text("policy_level"),
    /** Which plane decided: 'worker' | 'docker' | 'e2b' | 'daytona'. */
    source: text("source"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("egress_events_run_id_index").on(table.runId),
    index("egress_events_org_created_at_index").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);
