import { describe, expect, it } from "vitest";

import { getEnvKeyHints } from "./env-key-hints";

const vars = (record: Record<string, string>) =>
  Object.entries(record).map(([key, value]) => ({ key, value }));

describe("getEnvKeyHints", () => {
  it("suggests the canonical key for a known misspelling", () => {
    expect(
      getEnvKeyHints(vars({ AUTOMATA_PROJECTS: "ACME" }), "organization"),
    ).toEqual([
      {
        key: "AUTOMATA_PROJECTS",
        level: "warning",
        message:
          "AUTOMATA_PROJECTS is not read by the platform. Did you mean YOUTRACK_PROJECTS?",
      },
    ]);
  });

  it("flags a half-configured tracker on the organization", () => {
    const hints = getEnvKeyHints(
      vars({ YOUTRACK_URL: "https://acme.youtrack.cloud" }),
      "organization",
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]!.message).toContain("YOUTRACK_TOKEN is missing");
  });

  it("does not flag a single tracker key on a repository (it may override)", () => {
    expect(
      getEnvKeyHints(vars({ YOUTRACK_URL: "https://x" }), "repository"),
    ).toEqual([]);
  });

  it("explains shadow mode for a non-live writes value", () => {
    const hints = getEnvKeyHints(
      vars({ AUTOMATA_TRACKER_WRITES: "true" }),
      "repository",
    );
    expect(hints).toEqual([
      expect.objectContaining({
        key: "AUTOMATA_TRACKER_WRITES",
        level: "info",
      }),
    ]);
    expect(
      getEnvKeyHints(vars({ AUTOMATA_TRACKER_WRITES: "live" }), "repository"),
    ).toEqual([]);
  });

  it("warns that tracker keys in personal Global are not read by the audit", () => {
    const hints = getEnvKeyHints(
      vars({
        YOUTRACK_URL: "https://acme.youtrack.cloud",
        YOUTRACK_TOKEN: "perm:x",
        AUTOMATA_PROJECTS: "ACME",
      }),
      "global",
    );
    expect(hints.map((hint) => hint.key)).toEqual(["AUTOMATA_PROJECTS", null]);
    expect(hints[1]!.message).toContain(
      "YOUTRACK_URL, YOUTRACK_TOKEN are not read by the post-merge audit",
    );
  });

  it("returns nothing for ordinary keys", () => {
    expect(
      getEnvKeyHints(vars({ DATABASE_URL: "x", API_KEY: "y" }), "organization"),
    ).toEqual([]);
  });

  it("notes that SLACK_* outside the organization reach agents, not the integration", () => {
    for (const scope of ["global", "repository"] as const) {
      const hints = getEnvKeyHints(vars({ SLACK_SIGNING_SECRET: "s" }), scope);
      expect(hints).toHaveLength(1);
      expect(hints[0]!.level).toBe("info");
      expect(hints[0]!.message).toContain("delivered to agents as usual");
    }
  });

  it("flags a half-configured Slack app on the organization", () => {
    const hints = getEnvKeyHints(
      vars({ SLACK_CLIENT_ID: "c" }),
      "organization",
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]!.message).toContain(
      "SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET",
    );
  });

  it("accepts a complete Slack app on the organization", () => {
    expect(
      getEnvKeyHints(
        vars({
          SLACK_CLIENT_ID: "c",
          SLACK_CLIENT_SECRET: "s",
          SLACK_SIGNING_SECRET: "g",
        }),
        "organization",
      ),
    ).toEqual([]);
  });
});
