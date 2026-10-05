import { describe, it, vi, beforeEach, expect } from "vitest";
import * as z from "zod/v4";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestAutomation,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  createRepoSkillVersion,
  computeContentSha,
} from "@terragon/shared/model/repo-skills";
import { bindGithubInstallationToOrg } from "@terragon/shared/model/github-installation";
import { automations as automationsTable } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { User } from "@terragon/shared";
import type {
  AutomationAction,
  IssueTriggerConfig,
} from "@terragon/shared/automations";
import { upsertRepoReviewSetting } from "@terragon/shared/model/repo-review-settings";
import { createNewThread } from "./new-thread-shared";
import {
  runAutomation,
  validateAutomationCreationOrUpdate,
} from "./automations";
import { AUDIT_FIX_SKILL_NAME } from "./review/review-skill";
import { renderSkillPlaceholders } from "./review/resolve-review-skill";
import { resolveReviewPromptMode } from "./review/resolve-review-prompt-mode";

vi.mock("./new-thread-shared", () => ({
  createNewThread: vi
    .fn()
    .mockResolvedValue({ threadId: "t1", threadChatId: "tc1" }),
}));

// Pass-through spy: the real resolver runs, the tests can assert whether it
// was consulted at all.
vi.mock("./review/resolve-review-prompt-mode", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./review/resolve-review-prompt-mode")
    >();
  return {
    resolveReviewPromptMode: vi.fn(actual.resolveReviewPromptMode),
  };
});

describe("runAutomation — org inheritance (WI-5)", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(createNewThread).mockResolvedValue({
      threadId: "t1",
      threadChatId: "tc1",
    });
    user = (await createTestUser({ db })).user;
  });

  it("creates the thread with the automation's org", async () => {
    const org = await createOrganization({
      db,
      name: "Acme",
      slug: `acme-${nanoid(8).toLowerCase()}`,
    });
    const automation = await createTestAutomation({ db, userId: user.id });
    // An automation is org-owned; stamp its org.
    await db
      .update(automationsTable)
      .set({ organizationId: org.id })
      .where(eq(automationsTable.id, automation.id));

    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });

    expect(createNewThread).toHaveBeenCalledTimes(1);
    expect(createNewThread).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: org.id }),
    );
  });

  it("passes a null org when the automation has none (nullable-safe)", async () => {
    const automation = await createTestAutomation({ db, userId: user.id });

    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });

    const callArgs = vi.mocked(createNewThread).mock.calls[0]?.[0];
    expect(callArgs?.organizationId ?? null).toBeNull();
  });

  it("shadow: runs as a shadow thread when the org's installation is in shadow mode", async () => {
    const org = await createOrganization({
      db,
      name: "ShadowOrg",
      slug: `shadow-${nanoid(8).toLowerCase()}`,
    });
    await bindGithubInstallationToOrg({
      db,
      installationId: Math.floor(Math.random() * 1_000_000_000),
      organizationId: org.id,
      mode: "shadow",
    });
    const automation = await createTestAutomation({ db, userId: user.id });
    await db
      .update(automationsTable)
      .set({ organizationId: org.id })
      .where(eq(automationsTable.id, automation.id));

    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });

    expect(createNewThread).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: org.id, shadow: true }),
    );
  });

  it("active/none: runs as a non-shadow thread when the org has no shadow installation", async () => {
    const org = await createOrganization({
      db,
      name: "ActiveOrg",
      slug: `active-${nanoid(8).toLowerCase()}`,
    });
    await bindGithubInstallationToOrg({
      db,
      installationId: Math.floor(Math.random() * 1_000_000_000),
      organizationId: org.id,
      mode: "active",
    });
    const automation = await createTestAutomation({ db, userId: user.id });
    await db
      .update(automationsTable)
      .set({ organizationId: org.id })
      .where(eq(automationsTable.id, automation.id));

    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });

    expect(createNewThread).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: org.id, shadow: false }),
    );
  });
});

describe("runAutomation — skill_message resolution (#54 C2)", () => {
  let user: User;
  let orgId: string;

  /** Valid github-ops body: fenced-json contract + both placeholders. */
  const SKILL_BODY =
    "Review {{repoFullName}} against origin/{{baseBranch}}.\n" +
    '```json\n{ "verdict": "approve" }\n```\n';

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(createNewThread).mockResolvedValue({
      threadId: "t1",
      threadChatId: "tc1",
    });
    user = (await createTestUser({ db })).user;
    const org = await createOrganization({
      db,
      name: "SkillOrg",
      slug: `skill-${nanoid(8).toLowerCase()}`,
    });
    orgId = org.id;
  });

  async function makeSkillAutomation() {
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: {
        action: {
          type: "skill_message",
          config: { skillName: "github-ops", version: "latest" },
        },
      },
    });
    await db
      .update(automationsTable)
      .set({ organizationId: orgId })
      .where(eq(automationsTable.id, automation.id));
    return automation;
  }

  it("resolves the current skill version, renders placeholders, stamps sourceMetadata", async () => {
    const automation = await makeSkillAutomation();
    const { version } = await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: automation.repoFullName,
      skillName: "github-ops",
      body: SKILL_BODY,
      source: "seed",
    });

    const result = await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });
    expect(result).toEqual({ threadId: "t1", threadChatId: "tc1" });

    expect(createNewThread).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(createNewThread).mock.calls[0]![0];
    // Placeholders rendered from the automation's repo + base branch.
    const text = (callArgs.message.parts[0] as { text: string }).text;
    expect(text).toContain("Review terragon/test-repo against origin/main.");
    expect(text).toContain('"verdict"');
    expect(text).not.toContain("{{repoFullName}}");
    // Traceability: the sha of the STORED body (pre-render), plus the tier.
    expect(callArgs.sourceMetadata).toEqual({
      type: "automation-skill",
      skillName: "github-ops",
      contentSha: computeContentSha(SKILL_BODY),
      source: "db-version",
      versionId: version.id,
    });
    expect(callArgs.organizationId).toBe(orgId);
  });

  it("{{baseBranch}} renders the PR's BASE ref, never its head (PR #59 regression)", async () => {
    // For PR events options.branchName is the HEAD ref (the sandbox
    // checkout); rendering it into {{baseBranch}} makes
    // `git diff origin/<base>...HEAD` provably empty — caught live on #59.
    const automation = await makeSkillAutomation();
    await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: automation.repoFullName,
      skillName: "github-ops",
      body: SKILL_BODY,
      source: "seed",
    });
    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
      options: {
        branchName: "feat/some-pr-head",
        prBaseBranchName: "develop",
        prNumber: 41,
      },
    });
    const callArgs = vi.mocked(createNewThread).mock.calls[0]![0];
    const text = (callArgs.message.parts[0] as { text: string }).text;
    // The skill diffs against the PR base...
    expect(text).toContain("against origin/develop.");
    expect(text).not.toContain("origin/feat/some-pr-head");
    // ...while the thread itself still works on the PR head.
    expect(callArgs.baseBranchName).toBe("feat/some-pr-head");
  });

  it("an edit is live on the next run — no reseed, new sha stamped", async () => {
    const automation = await makeSkillAutomation();
    await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: automation.repoFullName,
      skillName: "github-ops",
      body: SKILL_BODY,
      source: "seed",
    });
    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });

    const editedBody = SKILL_BODY + "\nEDITED SENTENCE.";
    const { version: v2 } = await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: automation.repoFullName,
      skillName: "github-ops",
      body: editedBody,
      source: "dashboard",
    });
    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });

    const secondCall = vi.mocked(createNewThread).mock.calls[1]![0];
    expect((secondCall.message.parts[0] as { text: string }).text).toContain(
      "EDITED SENTENCE.",
    );
    expect(secondCall.sourceMetadata).toMatchObject({
      contentSha: computeContentSha(editedBody),
      versionId: v2.id,
    });
  });

  it("transformMessage still applies on top of the resolved skill message", async () => {
    const automation = await makeSkillAutomation();
    await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: automation.repoFullName,
      skillName: "github-ops",
      body: SKILL_BODY,
      source: "seed",
    });
    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
      options: {
        transformMessage: (message) => ({
          ...message,
          parts: [{ type: "text", text: "PREPENDED EVENT." }, ...message.parts],
        }),
      },
    });
    const callArgs = vi.mocked(createNewThread).mock.calls[0]![0];
    expect((callArgs.message.parts[0] as { text: string }).text).toBe(
      "PREPENDED EVENT.",
    );
    expect((callArgs.message.parts[1] as { text: string }).text).toContain(
      "Review terragon/test-repo",
    );
  });

  it("a defaultless skill with no usable version SKIPS the run (no thread)", async () => {
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: {
        action: {
          type: "skill_message",
          config: { skillName: "github-mention", version: "latest" },
        },
      },
    });
    await db
      .update(automationsTable)
      .set({ organizationId: orgId })
      .where(eq(automationsTable.id, automation.id));

    const result = await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });
    expect(result).toBeUndefined();
    expect(createNewThread).not.toHaveBeenCalled();
  });
});

describe("runAutomation — review prompt mode (phase 6)", () => {
  let user: User;
  let orgId: string;

  /**
   * A marker body: classic paragraph, orchestrated block, the run-tests pair
   * and the github-ops verdict contract.
   */
  const MARKER_BODY =
    "Review {{repoFullName}} against origin/{{baseBranch}}.\n" +
    "<!-- automata:if classic -->\nCLASSIC ONLY.\n<!-- automata:endif -->\n" +
    "<!-- automata:if orchestrated -->\nLEAD REVIEWER.\n<!-- automata:endif -->\n" +
    "<!-- automata:if orchestrated run-tests -->\nRUN TESTS.\n<!-- automata:endif -->\n" +
    "<!-- automata:if orchestrated no-run-tests -->\nNO TESTS.\n<!-- automata:endif -->\n" +
    '```json\n{ "verdict": "approve" }\n```\n';
  const PLAIN_BODY =
    "Review {{repoFullName}}.\n" + '```json\n{ "verdict": "approve" }\n```\n';

  const PR_OPTIONS = {
    branchName: "feat/head",
    prBaseBranchName: "develop",
    prNumber: 7,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(createNewThread).mockResolvedValue({
      threadId: "t1",
      threadChatId: "tc1",
    });
    user = (await createTestUser({ db })).user;
    const org = await createOrganization({
      db,
      name: "PromptModeOrg",
      slug: `pm-${nanoid(8).toLowerCase()}`,
    });
    orgId = org.id;
  });

  async function makeAutomation({
    triggerType = "pull_request",
    skillName = "github-ops",
  }: {
    triggerType?: "pull_request" | "schedule";
    skillName?: string;
  } = {}) {
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: {
        triggerType,
        action: {
          type: "skill_message",
          config: { skillName, version: "latest" },
        },
      },
    });
    await db
      .update(automationsTable)
      .set({ organizationId: orgId })
      .where(eq(automationsTable.id, automation.id));
    return automation;
  }

  async function storeBody(skillName: string, body: string, repo: string) {
    return createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: repo,
      skillName,
      body,
      source: "seed",
    });
  }

  async function setRepoMode(repo: string, mode: "orchestrated" | null) {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: repo,
      patch: { reviewMode: mode },
    });
  }

  function threadCall(index: number) {
    const call = vi.mocked(createNewThread).mock.calls[index]?.[0];
    if (!call) throw new Error(`createNewThread call ${index} missing`);
    return {
      text: (call.message.parts[0] as { text: string }).text,
      sourceMetadata: call.sourceMetadata,
    };
  }

  it("orchestrated repo + PR review → orchestrated render and the stamp", async () => {
    const automation = await makeAutomation();
    const { version } = await storeBody(
      "github-ops",
      MARKER_BODY,
      automation.repoFullName,
    );
    await setRepoMode(automation.repoFullName, "orchestrated");

    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "automated",
      options: PR_OPTIONS,
    });

    const { text, sourceMetadata } = threadCall(0);
    expect(text).toBe(
      renderSkillPlaceholders(MARKER_BODY, {
        repoFullName: automation.repoFullName,
        baseBranch: "develop",
        reviewPrompt: { mode: "orchestrated", runTests: false },
      }),
    );
    expect(text).toContain("LEAD REVIEWER.");
    expect(text).toContain("NO TESTS.");
    expect(sourceMetadata).toEqual({
      type: "automation-skill",
      skillName: "github-ops",
      contentSha: computeContentSha(MARKER_BODY),
      source: "db-version",
      versionId: version.id,
      reviewPromptMode: "orchestrated",
    });
  });

  it("no review-settings rows → classic render and today's sourceMetadata", async () => {
    const automation = await makeAutomation();
    const { version } = await storeBody(
      "github-ops",
      MARKER_BODY,
      automation.repoFullName,
    );

    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "automated",
      options: PR_OPTIONS,
    });

    const { text, sourceMetadata } = threadCall(0);
    expect(text).toBe(
      "Review terragon/test-repo against origin/develop.\nCLASSIC ONLY.\n" +
        '```json\n{ "verdict": "approve" }\n```\n',
    );
    expect(sourceMetadata).toEqual({
      type: "automation-skill",
      skillName: "github-ops",
      contentSha: computeContentSha(MARKER_BODY),
      source: "db-version",
      versionId: version.id,
    });
  });

  it("orchestrated repo but a marker-free body → unchanged text, no stamp", async () => {
    const automation = await makeAutomation();
    await storeBody("github-ops", PLAIN_BODY, automation.repoFullName);
    await setRepoMode(automation.repoFullName, "orchestrated");

    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "automated",
      options: PR_OPTIONS,
    });

    const { text, sourceMetadata } = threadCall(0);
    expect(text).toBe(
      "Review terragon/test-repo.\n" +
        '```json\n{ "verdict": "approve" }\n```\n',
    );
    expect(sourceMetadata).not.toHaveProperty("reviewPromptMode");
  });

  it("orchestrated repo but not a PR review → classic render, no resolver call", async () => {
    const scheduled = await makeAutomation({ triggerType: "schedule" });
    await storeBody("github-ops", MARKER_BODY, scheduled.repoFullName);
    await setRepoMode(scheduled.repoFullName, "orchestrated");

    await runAutomation({
      userId: user.id,
      automationId: scheduled.id,
      source: "manual",
      options: PR_OPTIONS,
    });
    // A pull_request automation run without a PR number is not a review either.
    const prAutomation = await makeAutomation();
    await runAutomation({
      userId: user.id,
      automationId: prAutomation.id,
      source: "manual",
      options: { branchName: "feat/head", prBaseBranchName: "develop" },
    });

    for (const index of [0, 1]) {
      const { text, sourceMetadata } = threadCall(index);
      expect(text).toContain("CLASSIC ONLY.");
      expect(text).not.toContain("LEAD REVIEWER.");
      expect(text).not.toContain("<!-- automata:");
      expect(sourceMetadata).not.toHaveProperty("reviewPromptMode");
    }
    expect(resolveReviewPromptMode).not.toHaveBeenCalled();
  });

  it("a non-github-ops skill keeps its marker lines verbatim", async () => {
    const automation = await makeAutomation({ skillName: "custom-skill" });
    await storeBody("custom-skill", MARKER_BODY, automation.repoFullName);
    await setRepoMode(automation.repoFullName, "orchestrated");

    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "automated",
      options: PR_OPTIONS,
    });

    const { text, sourceMetadata } = threadCall(0);
    expect(text).toBe(
      MARKER_BODY.replaceAll(
        "{{repoFullName}}",
        automation.repoFullName,
      ).replaceAll("{{baseBranch}}", "develop"),
    );
    expect(sourceMetadata).not.toHaveProperty("reviewPromptMode");
    expect(resolveReviewPromptMode).not.toHaveBeenCalled();
  });

  it("flip-back: the next run after returning to classic gets the classic render", async () => {
    const automation = await makeAutomation();
    await storeBody("github-ops", MARKER_BODY, automation.repoFullName);
    await setRepoMode(automation.repoFullName, "orchestrated");
    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "automated",
      options: PR_OPTIONS,
    });
    await setRepoMode(automation.repoFullName, null);
    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "automated",
      options: PR_OPTIONS,
    });

    const first = threadCall(0);
    expect(first.text).toContain("LEAD REVIEWER.");
    expect(first.sourceMetadata).toMatchObject({
      reviewPromptMode: "orchestrated",
    });
    const second = threadCall(1);
    expect(second.text).toBe(
      renderSkillPlaceholders(MARKER_BODY, {
        repoFullName: automation.repoFullName,
        baseBranch: "develop",
        reviewPrompt: { mode: "classic", runTests: false },
      }),
    );
    expect(second.sourceMetadata).not.toHaveProperty("reviewPromptMode");
  });
});

describe("validateAutomationCreationOrUpdate — issue labels (phase 9)", () => {
  let user: User;

  beforeEach(async () => {
    user = (await createTestUser({ db })).user;
  });

  function validateIssue(
    config: IssueTriggerConfig,
    action: AutomationAction = {
      type: "skill_message",
      config: { skillName: "mirror", version: "latest" },
    },
  ) {
    return validateAutomationCreationOrUpdate({
      userId: user.id,
      automationId: null,
      updates: {
        name: "test",
        repoFullName: "owner/repo",
        branchName: "main",
        triggerType: "issue",
        triggerConfig: config,
        action,
      },
    });
  }

  it("rejects on.labeled without filter.labels", async () => {
    await expect(
      validateIssue({ filter: {}, on: { labeled: true } }),
    ).rejects.toThrow(
      "Trigger on label requires at least one label in the filter",
    );
    await expect(
      validateIssue({ filter: { labels: [] }, on: { labeled: true } }),
    ).rejects.toThrow(
      "Trigger on label requires at least one label in the filter",
    );
  });

  it("accepts on.labeled with filter.labels", async () => {
    await expect(
      validateIssue({ filter: { labels: ["bug"] }, on: { labeled: true } }),
    ).resolves.toBeDefined();
  });

  it("still requires at least one enabled trigger", async () => {
    await expect(validateIssue({ filter: {}, on: {} })).rejects.toThrow(
      "At least one trigger must be enabled",
    );
  });
});

const AUDIT_FIX_ACTION: AutomationAction = {
  type: "skill_message",
  config: { skillName: AUDIT_FIX_SKILL_NAME, version: "latest" },
};
const SELF_HEAL_ERROR =
  "Self-heal fix automations must trigger only on the automata:auto-fix label";
const VALID_AUDIT_FIX_CONFIG: IssueTriggerConfig = {
  filter: { includeAllAuthors: true, labels: ["Automata:Auto-Fix"] },
  on: { labeled: true },
};

describe("validateAutomationCreationOrUpdate — audit-fix is labeled-only (ROLL-01)", () => {
  let user: User;

  beforeEach(async () => {
    user = (await createTestUser({ db })).user;
  });

  function validate(
    triggerType: "issue" | "pull_request" | "manual",
    triggerConfig: unknown,
  ) {
    return validateAutomationCreationOrUpdate({
      userId: user.id,
      automationId: null,
      updates: {
        name: "fix",
        repoFullName: "owner/repo",
        branchName: "main",
        triggerType,
        triggerConfig: triggerConfig as IssueTriggerConfig,
        action: AUDIT_FIX_ACTION,
      },
    });
  }

  it("rejects an audit-fix automation that triggers on open", async () => {
    await expect(
      validate("issue", {
        filter: { labels: ["automata:auto-fix"] },
        on: { open: true },
      }),
    ).rejects.toThrow(SELF_HEAL_ERROR);
  });

  it("rejects labeled + open", async () => {
    await expect(
      validate("issue", {
        filter: { labels: ["automata:auto-fix"] },
        on: { labeled: true, open: true },
      }),
    ).rejects.toThrow(SELF_HEAL_ERROR);
  });

  it("rejects labels that do not include automata:auto-fix", async () => {
    await expect(
      validate("issue", {
        filter: { labels: ["documentation"] },
        on: { labeled: true },
      }),
    ).rejects.toThrow(SELF_HEAL_ERROR);
  });

  it("rejects a non-issue trigger", async () => {
    await expect(validate("manual", {})).rejects.toThrow(SELF_HEAL_ERROR);
    await expect(
      validate("pull_request", { filter: {}, on: { open: true } }),
    ).rejects.toThrow(SELF_HEAL_ERROR);
  });

  it("accepts labeled-only with automata:auto-fix (case-insensitive)", async () => {
    await expect(
      validate("issue", VALID_AUDIT_FIX_CONFIG),
    ).resolves.toBeDefined();
  });

  it("re-checks an existing audit-fix automation when only its trigger config is updated", async () => {
    const automation = await createTestAutomation({ db, userId: user.id });
    await db
      .update(automationsTable)
      .set({
        triggerType: "issue",
        triggerConfig: VALID_AUDIT_FIX_CONFIG,
        action: AUDIT_FIX_ACTION,
      })
      .where(eq(automationsTable.id, automation.id));
    await expect(
      validateAutomationCreationOrUpdate({
        userId: user.id,
        automationId: automation.id,
        updates: {
          triggerConfig: {
            filter: { includeAllAuthors: true },
            on: { open: true },
          },
        },
      }),
    ).rejects.toThrow(SELF_HEAL_ERROR);
  });
});

/**
 * ROLL-01 rollback simulation. A literal copy of the issue trigger schema as
 * it stood before phase 9 (origin/main 5481fd3,
 * packages/shared/src/automations/index.ts lines 56-79). zod strips unknown
 * keys, so this is what an old www sees when it re-parses a stored config.
 * Do NOT import it from the live module: the point is to freeze the past.
 */
const LEGACY_ISSUE_TRIGGER_SCHEMA = z.object({
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
    permissionMode: z.enum(["review", "plan", "allowAll"]).optional(),
  }),
});

/** The legacy handleIssueAutomation trigger condition (origin/main 5481fd3). */
function legacyShouldTrigger(
  eventAction: string,
  config: z.infer<typeof LEGACY_ISSUE_TRIGGER_SCHEMA>["config"],
): boolean {
  switch (eventAction) {
    case "opened":
      return !!config.on.open;
    default:
      return false;
  }
}

describe("audit-fix rollback simulation (ROLL-01)", () => {
  it("a valid audit-fix config has no trigger the legacy www can fire", async () => {
    const user = (await createTestUser({ db })).user;
    await expect(
      validateAutomationCreationOrUpdate({
        userId: user.id,
        automationId: null,
        updates: {
          name: "fix",
          repoFullName: "owner/repo",
          branchName: "main",
          triggerType: "issue",
          triggerConfig: VALID_AUDIT_FIX_CONFIG,
          action: AUDIT_FIX_ACTION,
        },
      }),
    ).resolves.toBeDefined();

    // Round-trip through JSON, as the jsonb column does.
    const stored: unknown = JSON.parse(
      JSON.stringify({ type: "issue", config: VALID_AUDIT_FIX_CONFIG }),
    );
    const legacy = LEGACY_ISSUE_TRIGGER_SCHEMA.parse(stored);
    expect(legacy.config.on.open).toBeFalsy();
    expect(legacy.config.on).not.toHaveProperty("labeled");
    expect(legacy.config.filter).not.toHaveProperty("labels");
    expect(legacyShouldTrigger("opened", legacy.config)).toBe(false);
    expect(legacyShouldTrigger("labeled", legacy.config)).toBe(false);
  });
});
