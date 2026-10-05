import { describe, expect, it } from "vitest";

import { AutomationTriggerSchema, type AutomationTrigger } from "./index";

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
