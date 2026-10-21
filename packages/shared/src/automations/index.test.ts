import { describe, expect, it } from "vitest";

import {
  AutomationTriggerSchema,
  isCompanionAutomation,
  validateCompanionAutomation,
  type AutomationTrigger,
} from "./index";

function parseIssue(config: unknown) {
  return AutomationTriggerSchema.safeParse({ type: "issue", config });
}

describe("AutomationTriggerSchema issue trigger", () => {
  it("parses a legacy config unchanged, with no added keys", () => {
    const legacy = { filter: { includeAllAuthors: true }, on: { open: true } };
    const result = parseIssue(legacy);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ type: "issue", config: legacy });
  });

  it("parses filter.labels with on.labeled", () => {
    const config = {
      filter: { labels: ["automata:auto-fix"] },
      on: { labeled: true },
    };
    const result = parseIssue(config);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ type: "issue", config });
  });

  it("parses filter.excludeLabels", () => {
    const config = {
      filter: { includeAllAuthors: true, excludeLabels: ["automata:finding"] },
      on: { open: true },
    };
    const result = parseIssue(config);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ type: "issue", config });
  });

  it("rejects more than 10 labels", () => {
    const labels = Array.from({ length: 11 }, (_, i) => `label-${i}`);
    expect(
      parseIssue({ filter: { labels }, on: { labeled: true } }).success,
    ).toBe(false);
    expect(
      parseIssue({ filter: { excludeLabels: labels }, on: { open: true } })
        .success,
    ).toBe(false);
  });

  it("rejects an empty or over-long label", () => {
    expect(
      parseIssue({ filter: { labels: [""] }, on: { labeled: true } }).success,
    ).toBe(false);
    expect(
      parseIssue({
        filter: { labels: ["x".repeat(51)] },
        on: { labeled: true },
      }).success,
    ).toBe(false);
    expect(
      parseIssue({ filter: { excludeLabels: [""] }, on: { open: true } })
        .success,
    ).toBe(false);
  });
});

describe("AutomationTriggerSchema other trigger types round-trip", () => {
  const samples: AutomationTrigger[] = [
    { type: "manual", config: {} },
    {
      type: "schedule",
      config: { cron: "0 9 * * *", timezone: "UTC", permissionMode: "plan" },
    },
    {
      type: "pull_request",
      config: {
        filter: { includeDraftPRs: true, includeAllAuthors: true },
        on: { open: true, update: false },
        autoArchiveOnComplete: true,
      },
    },
    {
      type: "github_mention",
      config: {
        filter: { includeBotMentions: true, botUsernames: "a,b" },
      },
    },
  ];

  for (const sample of samples) {
    it(`round-trips ${sample.type}`, () => {
      const result = AutomationTriggerSchema.safeParse(sample);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(sample);
    });
  }
});

describe("PR companion (filter.companion)", () => {
  const companion = {
    type: "pull_request" as const,
    config: {
      filter: {
        includeAllAuthors: true,
        excludeBotSenders: true,
        companion: true,
      },
      on: { open: true, update: true },
      permissionMode: "review" as const,
    },
  };
  const skill = {
    type: "skill_message",
    config: { skillName: "flutter-pr-companion", version: "latest" },
  };

  it("round-trips the flag (zod keeps it)", () => {
    const result = AutomationTriggerSchema.safeParse(companion);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(companion);
  });

  it("rejects a non-boolean flag", () => {
    expect(
      AutomationTriggerSchema.safeParse({
        ...companion,
        config: { ...companion.config, filter: { companion: "yes" } },
      }).success,
    ).toBe(false);
  });

  it("isCompanionAutomation: only a pull_request automation with the flag set to true", () => {
    expect(
      isCompanionAutomation({
        triggerType: "pull_request",
        triggerConfig: companion.config,
      }),
    ).toBe(true);
    expect(
      isCompanionAutomation({
        triggerType: "pull_request",
        triggerConfig: { filter: {}, on: { open: true } },
      }),
    ).toBe(false);
    expect(
      isCompanionAutomation({
        triggerType: "pull_request",
        triggerConfig: { filter: { companion: false }, on: { open: true } },
      }),
    ).toBe(false);
    expect(
      isCompanionAutomation({
        triggerType: "github_mention",
        triggerConfig: { filter: { companion: true } },
      }),
    ).toBe(false);
    expect(
      isCompanionAutomation({ triggerType: "pull_request", triggerConfig: {} }),
    ).toBe(false);
    expect(isCompanionAutomation(null)).toBe(false);
  });

  it("validateCompanionAutomation: skill action required, emit-only mode", () => {
    const check = (triggerConfig: unknown, action: { type: string } = skill) =>
      validateCompanionAutomation({
        triggerType: "pull_request",
        triggerConfig,
        action,
      });
    expect(check(companion.config)).toBeNull();
    const { permissionMode: _mode, ...unpinned } = companion.config;
    expect(check(unpinned)).toBeNull();
    expect(check(companion.config, { type: "user_message" })).toMatch(
      /must run a skill/,
    );
    expect(
      validateCompanionAutomation({
        triggerType: "pull_request",
        triggerConfig: companion.config,
        action: null,
      }),
    ).toMatch(/must run a skill/);
    expect(check({ ...companion.config, permissionMode: "allowAll" })).toMatch(
      /emit-only/,
    );
    expect(check({ ...companion.config, permissionMode: "plan" })).toMatch(
      /emit-only/,
    );
    // Not a companion: nothing to say, whatever the action or mode.
    expect(
      check(
        { filter: {}, on: { open: true }, permissionMode: "allowAll" },
        { type: "user_message" },
      ),
    ).toBeNull();
    expect(
      validateCompanionAutomation({
        triggerType: undefined,
        triggerConfig: companion.config,
        action: undefined,
      }),
    ).toBeNull();
  });
});
