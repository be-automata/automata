import fs from "node:fs/promises";
import path from "node:path";

import {
  HARNESS_MANIFEST_REPO_PATH,
  isHarnessManifest,
  type HarnessManifest,
} from "../harness-manifest";
import {
  computeHarnessManifestHash,
  harnessPackDirName,
} from "../harness-layout";
import {
  REAL_REPO_ROOT,
  normaliseModes,
  type BatteriesFixture,
} from "./batteries-fixture";

/**
 * A fake HARNESS install on top of a batteries fixture, shaped like the
 * install-batteries.sh harness stages leave it (harness-layout.ts): the REAL
 * harness.json copied into `repoRoot`, `<root>/harness.sha256`, and per pack
 * `<root>/<id>@<pin>/` with a `.stamp` (`node 24`) and a small `claude/`
 * tree:
 *
 * - gstack: `skills/gstack/` plus `skills/investigate` as an in-pack symlink
 *   to `gstack/investigate`, an upstream `settings.json` (never linked) and
 *   `ms-playwright/`;
 * - gsd: a skill, agent files and an agent subdir, `commands/gsd/`, the
 *   shared `gsd-core/` dir, a `hooks/` dir and an upstream `settings.json`
 *   with a statusLine and an update hook (neither may reach a run);
 * - ruflo: `bin/ruflo-mcp` and `mcp-tools.json` (the allowlist plus two
 *   forbidden tools).
 */
export interface HarnessFixture {
  manifest: HarnessManifest;
  harnessHash: string;
  harnessPackDir: (id: string) => string;
}

export const FIXTURE_FORBIDDEN_RUFLO_TOOLS = [
  "agent_spawn",
  "terminal_execute",
];

async function write(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  await fs.writeFile(file, contents);
}

const SKILL = (name: string) => `---\nname: ${name}\n---\n# ${name}\n`;

export async function addHarnessInstall(
  fx: BatteriesFixture,
  { nodeMajor = 24 }: { nodeMajor?: number } = {},
): Promise<HarnessFixture> {
  const manifestBytes = await fs.readFile(
    path.join(REAL_REPO_ROOT, HARNESS_MANIFEST_REPO_PATH),
  );
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  if (!isHarnessManifest(manifest)) {
    throw new Error("fixture: the real harness.json is not a valid manifest");
  }
  await write(
    path.join(fx.repoRoot, HARNESS_MANIFEST_REPO_PATH),
    manifestBytes.toString("utf8"),
  );
  // The hash recipe reads each npm-lock pack's committed lockOverlay too.
  for (const pack of manifest.packs) {
    if (pack.kind === "npm-lock") {
      await write(
        path.join(fx.repoRoot, pack.lockOverlay),
        await fs.readFile(path.join(REAL_REPO_ROOT, pack.lockOverlay), "utf8"),
      );
    }
  }
  const harnessHash = await computeHarnessManifestHash(
    manifestBytes,
    manifest,
    fx.repoRoot,
  );
  const harnessPackDir = (id: string): string => {
    const pack = manifest.packs.find((p) => p.id === id);
    if (!pack) throw new Error(`fixture: no harness pack ${id}`);
    return path.join(fx.root, harnessPackDirName(pack));
  };

  const gstack = harnessPackDir("gstack");
  await write(
    path.join(gstack, "claude/skills/gstack/SKILL.md"),
    SKILL("gstack"),
  );
  await write(
    path.join(gstack, "claude/skills/gstack/investigate/SKILL.md"),
    SKILL("investigate"),
  );
  await fs.symlink(
    "gstack/investigate",
    path.join(gstack, "claude/skills/investigate"),
  );
  await write(path.join(gstack, "claude/settings.json"), '{"hooks":{}}\n');
  await write(path.join(gstack, "ms-playwright/chromium/README"), "chromium\n");

  const gsd = harnessPackDir("gsd");
  await write(
    path.join(gsd, "claude/skills/gsd-debug/SKILL.md"),
    SKILL("gsd-debug"),
  );
  await write(
    path.join(gsd, "claude/agents/gsd-debugger.md"),
    SKILL("gsd-debugger"),
  );
  await write(
    path.join(gsd, "claude/agents/gsd-planner.compact.md"),
    SKILL("gsd-planner"),
  );
  await write(path.join(gsd, "claude/agents/sub/nested.md"), SKILL("nested"));
  await write(path.join(gsd, "claude/commands/gsd/debug.md"), "# debug\n");
  await write(path.join(gsd, "claude/gsd-core/workflows/debug.md"), "# wf\n");
  await write(path.join(gsd, "claude/hooks/gsd-check-update.js"), "//\n");
  await write(
    path.join(gsd, "claude/settings.json"),
    JSON.stringify({
      statusLine: { type: "command", command: "gsd-statusline" },
      hooks: { SessionStart: [{ hooks: [{ command: "gsd-check-update" }] }] },
    }),
  );

  const ruflo = harnessPackDir("ruflo");
  const rufloPack = manifest.packs.find((p) => p.id === "ruflo");
  await write(path.join(ruflo, "bin/ruflo-mcp"), "#!/bin/sh\nexit 0\n");
  await write(
    path.join(ruflo, "mcp-tools.json"),
    JSON.stringify([
      ...(rufloPack?.toolAllowlist ?? []),
      ...FIXTURE_FORBIDDEN_RUFLO_TOOLS,
    ]),
  );

  for (const pack of manifest.packs) {
    const dir = harnessPackDir(pack.id);
    await write(
      path.join(dir, ".stamp"),
      `stamp ${"a".repeat(64)}\nsource fixture\nnode ${nodeMajor}\n`,
    );
    await normaliseModes(dir);
  }
  await fs.chmod(path.join(ruflo, "bin/ruflo-mcp"), 0o755);
  await write(path.join(fx.root, "harness.sha256"), `${harnessHash}\n`);
  await fs.chmod(path.join(fx.root, "harness.sha256"), 0o644);
  await fs.chmod(fx.root, 0o755);
  return { manifest, harnessHash, harnessPackDir };
}
