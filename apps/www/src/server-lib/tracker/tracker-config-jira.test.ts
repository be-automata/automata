import { describe, expect, it } from "vitest";

import {
  CONTROL_PLANE_ONLY_ENV_KEYS,
  describeEffectiveEnvironment,
  stripControlPlaneOnlyEnv,
} from "@/server-lib/env-audience";

import { createTrackerClient } from "./tracker-client";
import { parseTrackerConfig } from "./tracker-config";
import { TrackerConfigError } from "./tracker-types";

const vars = (record: Record<string, string>) =>
  Object.entries(record).map(([key, value]) => ({ key, value }));

const JIRA = {
  JIRA_URL: "https://acme.atlassian.net/",
  JIRA_USERNAME: "bot@acme.example",
  JIRA_API_TOKEN: "jira-secret",
};

describe("parseTrackerConfig — tracker kind selection", () => {
  it("selects Jira when JIRA_URL, JIRA_USERNAME and JIRA_API_TOKEN are set", () => {
    expect(
      parseTrackerConfig(
        vars({
          ...JIRA,
          JIRA_PROJECTS: " acme, OPS ,",
          AUTOMATA_TRACKER_WRITES: "live",
        }),
      ),
    ).toEqual({
      kind: "jira",
      baseUrl: "https://acme.atlassian.net",
      username: "bot@acme.example",
      token: "jira-secret",
      projects: ["ACME", "OPS"],
      writes: "live",
    });
  });

  it("defaults to shadow and generic key matching", () => {
    const config = parseTrackerConfig(vars(JIRA));
    expect(config?.kind).toBe("jira");
    expect(config?.writes).toBe("off");
    expect(config?.projects).toEqual([]);
  });

  it("Jira wins over YouTrack when both are fully configured", () => {
    expect(
      parseTrackerConfig(
        vars({
          ...JIRA,
          YOUTRACK_URL: "https://acme.youtrack.cloud",
          YOUTRACK_TOKEN: "perm:x",
        }),
      )?.kind,
    ).toBe("jira");
  });

  it("a half-configured Jira falls back to YouTrack (or nothing)", () => {
    const { JIRA_API_TOKEN: _omitted, ...partial } = JIRA;
    expect(parseTrackerConfig(vars(partial))).toBeNull();
    expect(
      parseTrackerConfig(
        vars({
          ...partial,
          YOUTRACK_URL: "https://acme.youtrack.cloud",
          YOUTRACK_TOKEN: "perm:x",
        }),
      )?.kind,
    ).toBe("youtrack");
  });

  it("throws on an unsafe JIRA_URL instead of reading as unconfigured", () => {
    expect(() =>
      parseTrackerConfig(vars({ ...JIRA, JIRA_URL: "http://10.0.0.1" })),
    ).toThrow(TrackerConfigError);
  });

  it("the factory builds a Jira client for a Jira config", () => {
    const config = parseTrackerConfig(vars(JIRA));
    expect(config).not.toBeNull();
    const tracker = createTrackerClient(config!);
    expect(tracker.issueUrl("ACME-1")).toBe(
      "https://acme.atlassian.net/browse/ACME-1",
    );
    expect(typeof tracker.listStageTargets).toBe("function");
  });
});

describe("JIRA_API_TOKEN is control-plane only", () => {
  it("is stripped from everything handed to an agent", () => {
    expect(CONTROL_PLANE_ONLY_ENV_KEYS.has("JIRA_API_TOKEN")).toBe(true);
    const stripped = stripControlPlaneOnlyEnv(
      vars({ ...JIRA, JIRA_PROJECTS: "ACME", API_KEY: "kept" }),
    );
    expect(stripped).toEqual(
      vars({
        JIRA_URL: JIRA.JIRA_URL,
        JIRA_USERNAME: JIRA.JIRA_USERNAME,
        JIRA_PROJECTS: "ACME",
        API_KEY: "kept",
      }),
    );
    expect(JSON.stringify(stripped)).not.toContain("jira-secret");
  });

  it("is reported as server only from every layer", () => {
    const entries = describeEffectiveEnvironment([
      { source: "global", keys: ["JIRA_API_TOKEN"] },
      { source: "organization", keys: ["JIRA_API_TOKEN", "JIRA_URL"] },
      { source: "repository", keys: ["JIRA_API_TOKEN"] },
    ]);
    expect(entries.find((entry) => entry.key === "JIRA_API_TOKEN")).toEqual({
      key: "JIRA_API_TOKEN",
      audience: "server",
      winningSource: "repository",
      shadowedSources: ["global", "organization"],
      serverOnlySources: ["global", "organization", "repository"],
    });
    expect(entries.find((entry) => entry.key === "JIRA_URL")?.audience).toBe(
      "agent",
    );
  });
});
