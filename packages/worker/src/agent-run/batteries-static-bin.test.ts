import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { findBatteriesManifestError } from "./batteries-manifest";

// A sha256-pinned standalone executable (the audit checks' pnpm): a GitHub
// release download of the pinned version naming a linux asset, nothing else.
const manifestPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "deploy",
  "batteries.json",
);
const SHA256 = "c".repeat(64);

function manifestWithTools(tools: unknown[]): unknown {
  const base: Record<string, unknown> = JSON.parse(
    fs.readFileSync(manifestPath, "utf8"),
  );
  return { ...base, tools };
}

const staticBin = (patch: Record<string, unknown> = {}) => ({
  name: "pnpm",
  kind: "static-bin",
  version: "10.14.0",
  url: "https://github.com/pnpm/pnpm/releases/download/v10.14.0/pnpm-linuxstatic-x64",
  sha256: SHA256,
  license: "MIT",
  ...patch,
});

describe("findBatteriesManifestError - static-bin tools", () => {
  it("accepts a well-formed static-bin tool", () => {
    expect(
      findBatteriesManifestError(manifestWithTools([staticBin()])),
    ).toBeUndefined();
  });

  it("accepts the committed manifest, pnpm included", () => {
    const committed: unknown = JSON.parse(
      fs.readFileSync(manifestPath, "utf8"),
    );
    expect(findBatteriesManifestError(committed)).toBeUndefined();
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["unknown key", { extra: 1 }, "tools[0].extra"],
    ["a wrapper key", { wrapper: "pnpm" }, "tools[0].wrapper"],
    ["bad sha256", { sha256: "c".repeat(63) }, "tools[0].sha256"],
    ["bad version", { version: "10.14" }, "tools[0].version"],
    [
      "url for another version",
      {
        url: "https://github.com/pnpm/pnpm/releases/download/v10.13.0/pnpm-linuxstatic-x64",
      },
      "tools[0].url",
    ],
    [
      "url over http",
      {
        url: "http://github.com/pnpm/pnpm/releases/download/v10.14.0/pnpm-linuxstatic-x64",
      },
      "tools[0].url",
    ],
    [
      "url off github",
      {
        url: "https://example.com/pnpm/pnpm/releases/download/v10.14.0/pnpm-linuxstatic-x64",
      },
      "tools[0].url",
    ],
    [
      "a non-linux asset",
      {
        url: "https://github.com/pnpm/pnpm/releases/download/v10.14.0/pnpm-macos-arm64",
      },
      "tools[0].url",
    ],
    [
      "a trailing query",
      {
        url: "https://github.com/pnpm/pnpm/releases/download/v10.14.0/pnpm-linuxstatic-x64?x=1",
      },
      "tools[0].url",
    ],
    ["empty license", { license: " " }, "tools[0].license"],
  ])("rejects %s", (_name, patch, fragment) => {
    const error = findBatteriesManifestError(
      manifestWithTools([staticBin(patch)]),
    );
    expect(error).toBeDefined();
    expect(error).toContain(fragment);
  });
});
