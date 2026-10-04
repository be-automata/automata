import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BATTERIES_MANIFEST_REPO_PATH,
  type BatteriesManifest,
} from "../batteries-manifest";

/**
 * A fake install of the review batteries, shaped like install-batteries.sh
 * leaves it: `<root>/<id>@<sha>/` per pack holding every manifest `dest`, dirs
 * 0755 and files 0644, plus `<root>/manifest.sha256`. `repoRoot` holds a copy
 * of the REAL batteries.json and its overlay files, so a manifest change that
 * breaks seeding fails these tests too.
 */
export interface BatteriesFixture {
  base: string;
  root: string;
  repoRoot: string;
  home: string;
  manifest: BatteriesManifest;
  manifestHash: string;
  packDir: (id: string) => string;
  cleanup: () => Promise<void>;
}

/** this file: packages/worker/src/agent-run/__fixtures__ → up 3 = packages/worker. */
const WORKER_PKG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
export const REAL_REPO_ROOT = path.resolve(WORKER_PKG_ROOT, "..", "..");

/** dests that are files; every other dest is a directory (a vendored subtree). */
function isFileDest(dest: string): boolean {
  return dest === "LICENSE" || dest.endsWith(".md") || dest.endsWith("LICENSE");
}

async function writeFile0644(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  await fs.writeFile(file, contents);
  await fs.chmod(file, 0o644);
}

/** chmod every dir 0755 and file 0644 under `dir`, like the installer. */
export async function normaliseModes(dir: string): Promise<void> {
  await fs.chmod(dir, 0o755);
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await normaliseModes(full);
    } else if (entry.isFile()) {
      await fs.chmod(full, 0o644);
    }
  }
}

export async function makeBatteriesFixture(): Promise<BatteriesFixture> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "automata-batt-"));
  const root = path.join(base, "root");
  const repoRoot = path.join(base, "repo");
  const home = path.join(base, "home");
  await fs.mkdir(root, { mode: 0o755 });
  await fs.mkdir(home, { mode: 0o700 });

  const manifestBytes = await fs.readFile(
    path.join(REAL_REPO_ROOT, BATTERIES_MANIFEST_REPO_PATH),
  );
  const manifest = JSON.parse(
    manifestBytes.toString("utf8"),
  ) as BatteriesManifest;
  await fs.mkdir(
    path.dirname(path.join(repoRoot, BATTERIES_MANIFEST_REPO_PATH)),
    {
      recursive: true,
    },
  );
  await fs.writeFile(
    path.join(repoRoot, BATTERIES_MANIFEST_REPO_PATH),
    manifestBytes,
  );

  const hash = createHash("sha256").update(manifestBytes);
  for (const pack of manifest.packs) {
    for (const overlay of pack.overlays ?? []) {
      const bytes = await fs.readFile(path.join(REAL_REPO_ROOT, overlay.from));
      await fs.mkdir(path.dirname(path.join(repoRoot, overlay.from)), {
        recursive: true,
      });
      await fs.writeFile(path.join(repoRoot, overlay.from), bytes);
      hash.update(bytes);
    }
  }
  const manifestHash = hash.digest("hex");

  const packDir = (id: string): string => {
    const pack = manifest.packs.find((p) => p.id === id);
    if (!pack) {
      throw new Error(`fixture: no pack ${id}`);
    }
    return path.join(root, `${pack.id}@${pack.sha}`);
  };

  for (const pack of manifest.packs) {
    const dir = packDir(pack.id);
    const dests = [
      ...pack.subpaths.map((s) => s.dest),
      ...(pack.overlays ?? []).map((o) => o.dest),
    ];
    for (const dest of dests) {
      if (isFileDest(dest)) {
        await writeFile0644(path.join(dir, dest), `${pack.id}:${dest}\n`);
      } else {
        await writeFile0644(
          path.join(dir, dest, "README.md"),
          `${pack.id}:${dest}\n`,
        );
      }
    }
    await normaliseModes(dir);
  }
  await writeFile0644(path.join(root, "manifest.sha256"), `${manifestHash}\n`);
  await fs.chmod(root, 0o755);

  return {
    base,
    root,
    repoRoot,
    home,
    manifest,
    manifestHash,
    packDir,
    cleanup: async () => {
      await fs.rm(base, { recursive: true, force: true });
    },
  };
}
