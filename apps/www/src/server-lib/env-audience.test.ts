import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CONTROL_PLANE_ONLY_ENV_KEYS,
  mergeEnvironmentLayers,
  stripControlPlaneOnlyEnv,
  withAgentTrackerTokenFallback,
} from "./env-audience";

const vars = (record: Record<string, string>) =>
  Object.entries(record).map(([key, value]) => ({ key, value }));

describe("stripControlPlaneOnlyEnv", () => {
  it("removes the tracker token and keeps everything else, in order", () => {
    const input = vars({
      NODE_ENV: "test",
      YOUTRACK_TOKEN: "perm:secret",
      YOUTRACK_URL: "https://yt.example.com",
      API_KEY: "kept",
    });
    expect(stripControlPlaneOnlyEnv(input)).toEqual(
      vars({
        NODE_ENV: "test",
        YOUTRACK_URL: "https://yt.example.com",
        API_KEY: "kept",
      }),
    );
    // Non-mutating.
    expect(input).toHaveLength(4);
    expect(CONTROL_PLANE_ONLY_ENV_KEYS.has("YOUTRACK_TOKEN")).toBe(true);
  });
});

describe("withAgentTrackerTokenFallback", () => {
  it("hands the tracker token over as the agent token when none is set", () => {
    expect(
      withAgentTrackerTokenFallback({
        YOUTRACK_URL: "https://yt.example.com",
        YOUTRACK_TOKEN: "perm:owner",
      }),
    ).toEqual({
      YOUTRACK_URL: "https://yt.example.com",
      YOUTRACK_TOKEN: "perm:owner",
      YOUTRACK_AGENT_TOKEN: "perm:owner",
    });
  });

  it("keeps a dedicated agent token", () => {
    const input = {
      YOUTRACK_TOKEN: "perm:owner",
      YOUTRACK_AGENT_TOKEN: "perm:bot",
    };
    expect(withAgentTrackerTokenFallback(input)).toBe(input);
  });

  it("adds nothing without a tracker token", () => {
    const input = { YOUTRACK_URL: "https://yt.example.com" };
    expect(withAgentTrackerTokenFallback(input)).toBe(input);
  });

  it("uses only the personal token it is given, never the merged one", () => {
    // The merged YOUTRACK_TOKEN came from the organization layer; with no
    // personal token, nothing is handed to the agent.
    const input = { YOUTRACK_TOKEN: "perm:org" };
    expect(
      withAgentTrackerTokenFallback(input, { personalTrackerToken: undefined }),
    ).toBe(input);
    expect(
      withAgentTrackerTokenFallback(input, {
        personalTrackerToken: "perm:mine",
      }),
    ).toEqual({
      YOUTRACK_TOKEN: "perm:org",
      YOUTRACK_AGENT_TOKEN: "perm:mine",
    });
  });
});

describe("mergeEnvironmentLayers", () => {
  it("overlays in order, records the source, and leaves inputs alone", () => {
    const global = vars({ A: "global", B: "global" });
    const organization = vars({ B: "org", C: "org" });
    const repository = vars({ C: "repo" });
    expect(
      mergeEnvironmentLayers([
        { source: "global", variables: global },
        { source: "organization", variables: organization },
        { source: "repository", variables: repository },
      ]),
    ).toEqual({
      A: { value: "global", source: "global" },
      B: { value: "org", source: "organization" },
      C: { value: "repo", source: "repository" },
    });
    expect(global).toEqual(vars({ A: "global", B: "global" }));
  });
});

/**
 * ADR-008 invariant I1, enforced structurally: stored environment variables
 * are decrypted in exactly ONE module, which makes every reader choose an
 * audience. A module that imported the shared decrypt functions directly could
 * hand the tracker token to a sandbox without anyone noticing — so no module
 * but `env-audience.ts` may import them.
 */
describe("env-audience is the only decrypt site (ADR-008 I1)", () => {
  const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));
  const DECRYPT_IMPORT = /getDecrypted\w*EnvironmentVariables\b/;

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        return entry === "node_modules" ? [] : sourceFiles(full);
      }
      return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)
        ? [full]
        : [];
    });
  }

  const files = sourceFiles(SRC_ROOT).map((file) => ({
    relative: path.relative(SRC_ROOT, file).split(path.sep).join("/"),
    source: readFileSync(file, "utf8"),
  }));

  it("no other module references the shared decrypt functions", () => {
    const offenders = files
      .filter(({ source }) => DECRYPT_IMPORT.test(source))
      .map(({ relative }) => relative);
    expect(offenders).toEqual(["server-lib/env-audience.ts"]);
  });

  it("everything handed to an execution plane uses the stripped getters", () => {
    const executionPlane = [
      "agent/sandbox.ts",
      "app/api/run-setup-script/stream/route.ts",
      "app/api/internal/broadcast/sandbox/env/route.ts",
    ];
    for (const relative of executionPlane) {
      const file = files.find((candidate) => candidate.relative === relative);
      expect(file, relative).toBeDefined();
      expect(file!.source, relative).toMatch(/getExecutionPlane/);
      expect(file!.source, relative).not.toMatch(/getControlPlane/);
    }
  });

  it("the raw getters are used only where values stay on the control plane", () => {
    const rawReaders = files
      .filter(
        ({ relative, source }) =>
          relative !== "server-lib/env-audience.ts" &&
          /getControlPlane\w*Environment(?:Variables)?\b/.test(source),
      )
      .map(({ relative }) => relative)
      .sort();
    expect(rawReaders).toEqual([
      "app/(sidebar)/(site-header)/environments/[id]/page.tsx",
      "app/(sidebar)/(site-header)/environments/global/page.tsx",
      "server-lib/tracker/tracker-config.ts",
    ]);
  });

  it("the tracker path never reads the personal global environment", () => {
    const trackerConfig = files.find(
      ({ relative }) => relative === "server-lib/tracker/tracker-config.ts",
    );
    expect(trackerConfig!.source).not.toMatch(/Global\w*Environment/);
    const audience = files.find(
      ({ relative }) => relative === "server-lib/env-audience.ts",
    )!.source;
    const start = audience.indexOf(
      "export async function getControlPlaneTrackerEnvironment",
    );
    const body = audience.slice(start, audience.indexOf("\n}\n", start));
    expect(body).toMatch(/readOrganizationLayer\(/);
    expect(body).not.toMatch(/Global/);
  });

  it("the remote run environment strips control-plane keys after the fallback", () => {
    const file = files.find(
      ({ relative }) => relative === "server-lib/env-audience.ts",
    );
    const body = file!.source.slice(
      file!.source.indexOf(
        "export async function getExecutionPlaneRunEnvironment",
      ),
    );
    expect(body).toMatch(/withAgentTrackerTokenFallback\(/);
    expect(body).toMatch(/CONTROL_PLANE_ONLY_ENV_KEYS\.has\(key\)/);
    // The organization layer sits between global and repository, and the
    // fallback is fed from the personal layers only.
    expect(body).toMatch(
      /source: "global"[\s\S]*source: "organization"[\s\S]*source: "repository"/,
    );
    expect(body).toMatch(/personalTrackerToken: personal\.YOUTRACK_TOKEN/);
  });
});
