import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CONTROL_PLANE_ONLY_ENV_KEYS,
  stripControlPlaneOnlyEnv,
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

/**
 * ADR-008 invariant I1, enforced structurally: stored environment variables
 * are decrypted in exactly ONE module, which makes every reader choose an
 * audience. A module that imported the shared decrypt functions directly could
 * hand the tracker token to a sandbox without anyone noticing — so no module
 * but `env-audience.ts` may import them.
 */
describe("env-audience is the only decrypt site (ADR-008 I1)", () => {
  const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));
  const DECRYPT_IMPORT = /getDecrypted(?:Global)?EnvironmentVariables\b/;

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
          /getControlPlane(?:Global)?EnvironmentVariables\b/.test(source),
      )
      .map(({ relative }) => relative)
      .sort();
    expect(rawReaders).toEqual([
      "app/(sidebar)/(site-header)/environments/[id]/page.tsx",
      "app/(sidebar)/(site-header)/environments/global/page.tsx",
      "server-lib/tracker/tracker-config.ts",
    ]);
  });
});
