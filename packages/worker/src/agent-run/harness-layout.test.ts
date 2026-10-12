import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeHarnessManifestHash,
  parseHarnessStamp,
  resolvePackDirTemplate,
} from "./harness-layout";
import type { HarnessManifest } from "./harness-manifest";

describe("computeHarnessManifestHash", () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harness-layout-"));
  });
  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("hashes the manifest bytes, then each pack's lockOverlay in manifest order", async () => {
    await fs.writeFile(path.join(repoRoot, "a.lock"), "A");
    await fs.writeFile(path.join(repoRoot, "b.lock"), "B");
    const bytes = Buffer.from("{manifest}");
    const manifest = {
      schemaVersion: 1,
      packs: [
        { id: "gstack" },
        { id: "gsd", lockOverlay: "a.lock" },
        { id: "ruflo", lockOverlay: "b.lock" },
      ],
    } as unknown as HarnessManifest;
    expect(await computeHarnessManifestHash(bytes, manifest, repoRoot)).toBe(
      createHash("sha256")
        .update("{manifest}")
        .update("A")
        .update("B")
        .digest("hex"),
    );
  });

  it("no lockOverlay anywhere: the manifest bytes alone", async () => {
    const manifest = {
      schemaVersion: 1,
      packs: [{ id: "gstack" }],
    } as unknown as HarnessManifest;
    expect(
      await computeHarnessManifestHash(Buffer.from("x"), manifest, repoRoot),
    ).toBe(createHash("sha256").update("x").digest("hex"));
  });
});

describe("parseHarnessStamp", () => {
  const STAMP = "c".repeat(64);

  it("reads the stamp and the node major", () => {
    expect(
      parseHarnessStamp(`stamp ${STAMP}\nsource x\nnode 24\nfoo.node ab\n`),
    ).toEqual({ stamp: STAMP, nodeMajor: 24 });
  });

  it("no node line: no nodeMajor", () => {
    expect(parseHarnessStamp(`stamp ${STAMP}\n`)).toEqual({ stamp: STAMP });
  });

  it("a first line that is not `stamp <64 hex>`: undefined", () => {
    expect(parseHarnessStamp(`node 24\nstamp ${STAMP}\n`)).toBeUndefined();
    expect(parseHarnessStamp("stamp abc\n")).toBeUndefined();
  });
});

describe("resolvePackDirTemplate", () => {
  it("replaces only a leading {{packDir}}", () => {
    expect(resolvePackDirTemplate("{{packDir}}/bin/x", "/p")).toBe("/p/bin/x");
    expect(resolvePackDirTemplate("30000", "/p")).toBe("30000");
  });
});
