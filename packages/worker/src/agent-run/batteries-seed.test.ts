import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listTree,
  makeBatteriesFixture,
  REAL_REPO_ROOT,
  type BatteriesFixture,
} from "./__fixtures__/batteries-fixture";
import {
  addHarnessInstall,
  FIXTURE_FORBIDDEN_RUFLO_TOOLS,
  type HarnessFixture,
} from "./__fixtures__/harness-fixture";
import {
  LINUX_DIR_REGRANT_RIGHTS,
  LINUX_FILE_REGRANT_RIGHTS,
} from "./agent-uid-fs";
import { BATTERIES_MANIFEST_REPO_PATH } from "./batteries-manifest";
import {
  BATTERIES_ROOT_DEFAULT,
  computeBatteriesManifestHash,
  formatBatteriesLine,
  harnessDoctorLine,
  seedBatteries,
  seedForegroundOnly,
  type SeedBatteriesOptions,
} from "./batteries-seed";
import { FOREGROUND_ONLY_PRE_TOOL_USE } from "./foreground-only-hook";
import { HARNESS_MANIFEST_REPO_PATH } from "./harness-manifest";

const UID = process.getuid?.() ?? 0;

describe("seedBatteries (Phase 5)", () => {
  let fx: BatteriesFixture;
  let logs: string[];
  let opts: SeedBatteriesOptions;

  beforeEach(async () => {
    fx = await makeBatteriesFixture();
    logs = [];
    opts = {
      root: fx.root,
      repoRoot: fx.repoRoot,
      rootOwnerUid: UID,
      packOwnerUid: UID,
      log: (line) => logs.push(line),
    };
  });
  afterEach(async () => {
    await fx.cleanup();
  });

  const claudeDir = () => path.join(fx.home, ".claude");

  async function readSettings(): Promise<Record<string, unknown>> {
    return JSON.parse(
      await fs.readFile(path.join(claudeDir(), "settings.json"), "utf8"),
    ) as Record<string, unknown>;
  }

  it("exports the production install root", () => {
    expect(BATTERIES_ROOT_DEFAULT).toBe("/usr/local/lib/automata-batteries");
  });

  it("links exactly the selected packs' skills dirs and agent files, in MANIFEST order", async () => {
    const result = await seedBatteries(
      fx.home,
      ["gsd-reviewers", "gstack-review"],
      opts,
    );
    expect(result).toEqual({
      ok: true,
      packs: ["gstack-review", "gsd-reviewers"],
      manifestHash: fx.manifestHash,
    });
    expect(fx.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await listTree(claudeDir())).toEqual([
      "agents",
      "agents/gsd-code-reviewer.md",
      "agents/gsd-security-auditor.md",
      "settings.json",
      "skills",
      "skills/gstack-review",
    ]);
    expect(
      await fs.readlink(path.join(claudeDir(), "skills/gstack-review")),
    ).toBe(
      path.join(
        await fs.realpath(fx.packDir("gstack-review")),
        "skills/gstack-review",
      ),
    );
    expect(
      await fs.readlink(path.join(claudeDir(), "agents/gsd-code-reviewer.md")),
    ).toBe(
      path.join(
        await fs.realpath(fx.packDir("gsd-reviewers")),
        "agents/gsd-code-reviewer.md",
      ),
    );
  });

  it("every created link is a symlink whose realpath is inside realpath(ROOT)", async () => {
    await seedBatteries(
      fx.home,
      ["gstack-review", "somnio-review", "gsd-reviewers"],
      opts,
    );
    const realRoot = await fs.realpath(fx.root);
    const links = [
      "skills/gstack-review",
      "skills/security-audit",
      "agents/gsd-code-reviewer.md",
      "agents/gsd-security-auditor.md",
    ];
    for (const rel of links) {
      const link = path.join(claudeDir(), rel);
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect((await fs.realpath(link)).startsWith(realRoot + path.sep)).toBe(
        true,
      );
    }
    const tree = await listTree(claudeDir());
    expect(tree.some((p) => p.includes("LICENSE"))).toBe(false);
  });

  it("writes disableAllHooks:true at 0600, merged over existing keys", async () => {
    await fs.mkdir(claudeDir(), { recursive: true });
    await fs.writeFile(
      path.join(claudeDir(), "settings.json"),
      JSON.stringify({ foo: 1 }),
    );
    await seedBatteries(fx.home, ["gstack-review"], opts);
    expect(await readSettings()).toEqual({ foo: 1, disableAllHooks: true });
    const mode =
      (await fs.stat(path.join(claudeDir(), "settings.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  describe("unavailable ⇒ no packs, never throws, settings still written", () => {
    async function expectUnavailable(reason: string) {
      const result = await seedBatteries(fx.home, ["gstack-review"], opts);
      expect(result).toEqual({ ok: false, reason });
      expect(await listTree(claudeDir())).toEqual(["settings.json"]);
      expect((await readSettings()).disableAllHooks).toBe(true);
      expect(logs.some((l) => l.includes(`reason=${reason}`))).toBe(true);
    }

    it("no manifest.sha256 ⇒ no-manifest-hash", async () => {
      await fs.rm(path.join(fx.root, "manifest.sha256"));
      await expectUnavailable("no-manifest-hash");
    });

    it("only manifest.sha256.invalid ⇒ manifest-invalidated", async () => {
      await fs.rename(
        path.join(fx.root, "manifest.sha256"),
        path.join(fx.root, "manifest.sha256.invalid"),
      );
      await expectUnavailable("manifest-invalidated");
    });

    it("manifest.sha256 not 64-hex ⇒ manifest-hash-malformed", async () => {
      await fs.writeFile(path.join(fx.root, "manifest.sha256"), "abc\n");
      await expectUnavailable("manifest-hash-malformed");
    });

    it("batteries.json unparseable ⇒ manifest-invalid", async () => {
      await fs.writeFile(
        path.join(fx.repoRoot, BATTERIES_MANIFEST_REPO_PATH),
        "{not json",
      );
      await expectUnavailable("manifest-invalid");
    });

    it("batteries.json failing the guard ⇒ manifest-invalid", async () => {
      await fs.writeFile(
        path.join(fx.repoRoot, BATTERIES_MANIFEST_REPO_PATH),
        JSON.stringify({ schemaVersion: 2 }),
      );
      await expectUnavailable("manifest-invalid");
    });

    it("hash ≠ manifest.sha256 ⇒ manifest-drift", async () => {
      await fs.writeFile(
        path.join(fx.root, "manifest.sha256"),
        `${"0".repeat(64)}\n`,
      );
      await expectUnavailable("manifest-drift");
    });

    it("a checkout edit after a verified run is re-hashed (per-process cache) ⇒ manifest-drift", async () => {
      expect((await seedBatteries(fx.home, ["gstack-review"], opts)).ok).toBe(
        true,
      );
      const overlay = fx.manifest.packs
        .flatMap((p) => p.overlays ?? [])
        .find(Boolean);
      if (!overlay) {
        throw new Error("fixture: the real manifest has no overlay");
      }
      await fs.appendFile(path.join(fx.repoRoot, overlay.from), "\nedited\n");
      await fs.rm(path.join(fx.home, ".claude"), {
        recursive: true,
        force: true,
      });
      await expectUnavailable("manifest-drift");
    });

    it("ROOT missing ⇒ root-not-trusted", async () => {
      opts = { ...opts, root: path.join(fx.base, "nope") };
      await expectUnavailable("root-not-trusted");
    });

    it("ROOT a symlink ⇒ root-not-trusted", async () => {
      const alias = path.join(fx.base, "root-alias");
      await fs.symlink(fx.root, alias);
      opts = { ...opts, root: alias };
      await expectUnavailable("root-not-trusted");
    });

    it("ROOT owned by someone else ⇒ root-not-trusted", async () => {
      opts = { ...opts, rootOwnerUid: UID + 1 };
      await expectUnavailable("root-not-trusted");
    });

    it("ROOT group/other-writable ⇒ root-not-trusted", async () => {
      await fs.chmod(fx.root, 0o775);
      await expectUnavailable("root-not-trusted");
    });
  });

  describe("ownership (W4: tested as non-root)", () => {
    it("pack owned by a uid ≠ packOwnerUid is skipped while ROOT passes", async () => {
      opts = { ...opts, packOwnerUid: UID + 1 };
      const result = await seedBatteries(fx.home, ["gstack-review"], opts);
      expect(result).toEqual({
        ok: true,
        packs: [],
        manifestHash: fx.manifestHash,
      });
      expect(logs).toContain(
        "batteries: skip pack gstack-review reason=not-root-owned",
      );
    });

    it("the default-0 owner check runs through the lstat seam (not bypassed)", async () => {
      const realRoot = await fs.realpath(fx.root);
      const underRoot = (p: string) =>
        p === fx.root ||
        p.startsWith(fx.root + path.sep) ||
        p === realRoot ||
        p.startsWith(realRoot + path.sep);
      const lstat: NonNullable<SeedBatteriesOptions["lstat"]> = async (p) => {
        const st = await fs.lstat(p);
        return {
          uid: underRoot(p) ? 0 : st.uid,
          mode: st.mode,
          isDirectory: () => st.isDirectory(),
          isFile: () => st.isFile(),
          isSymbolicLink: () => st.isSymbolicLink(),
        };
      };
      const result = await seedBatteries(fx.home, ["gstack-review"], {
        root: fx.root,
        repoRoot: fx.repoRoot,
        lstat,
        log: (l) => logs.push(l),
      });
      expect(result).toMatchObject({ ok: true, packs: ["gstack-review"] });

      // Without the seam, the same defaults reject a non-root-owned ROOT.
      if (UID !== 0) {
        await fs.rm(path.join(fx.home, ".claude"), {
          recursive: true,
          force: true,
        });
        const plain = await seedBatteries(fx.home, ["gstack-review"], {
          root: fx.root,
          repoRoot: fx.repoRoot,
          log: (l) => logs.push(l),
        });
        expect(plain).toEqual({ ok: false, reason: "root-not-trusted" });
      }
    });
  });

  describe("per-pack skip: the pack is omitted, others still link", () => {
    async function expectSkip(id: string, reason: string) {
      const result = await seedBatteries(
        fx.home,
        [id, "gsd-reviewers"].filter((v, i, a) => a.indexOf(v) === i),
        opts,
      );
      if (!result.ok) {
        throw new Error(`expected a verified manifest, got ${result.reason}`);
      }
      expect(result.packs).not.toContain(id);
      if (id !== "gsd-reviewers") {
        expect(result.packs).toContain("gsd-reviewers");
      }
      expect(logs).toContain(`batteries: skip pack ${id} reason=${reason}`);
      const tree = await listTree(claudeDir());
      if (id === "gstack-review") {
        expect(tree).not.toContain("skills/gstack-review");
      }
    }

    it("unknown id", async () => {
      await expectSkip("no-such-pack", "unknown-id");
    });

    it("pack dir missing", async () => {
      await fs.rm(fx.packDir("gstack-review"), { recursive: true });
      await expectSkip("gstack-review", "missing");
    });

    it("pack dir group/other-writable", async () => {
      await fs.chmod(fx.packDir("gstack-review"), 0o777);
      await expectSkip("gstack-review", "writable");
    });

    it("pack dir is a symlink", async () => {
      const dir = fx.packDir("gstack-review");
      const moved = path.join(fx.base, "elsewhere");
      await fs.rename(dir, moved);
      await fs.symlink(moved, dir);
      await expectSkip("gstack-review", "escapes-root");
    });

    it("a symlink inside the pack tree", async () => {
      await fs.symlink(
        "/etc/hosts",
        path.join(fx.packDir("gstack-review"), "skills/gstack-review/x.md"),
      );
      await expectSkip("gstack-review", "symlink-in-pack");
    });

    it.each([
      "skills/gstack-review/hooks/run.sh",
      "skills/gstack-review/settings.json",
      "skills/gstack-review/bin/tool",
      "agents/.mcp.json",
    ])("a forbidden path segment (%s)", async (rel) => {
      const file = path.join(fx.packDir("gstack-review"), rel);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
      await fs.writeFile(file, "x");
      await fs.chmod(file, 0o644);
      await expectSkip("gstack-review", "forbidden-entry");
    });
  });

  it("links only ID_OR_NAME skill dirs and agents/<name>.md regular files", async () => {
    const dir = fx.packDir("gsd-reviewers");
    await fs.mkdir(path.join(dir, "skills"), { mode: 0o755 });
    await fs.mkdir(path.join(dir, "skills/Bad_Name"), { mode: 0o755 });
    await fs.mkdir(path.join(dir, "skills/good-one"), { mode: 0o755 });
    await fs.writeFile(path.join(dir, "skills/loose-file.md"), "x");
    await fs.writeFile(path.join(dir, "agents/notes.txt"), "x");
    await fs.writeFile(path.join(dir, "agents/Upper.md"), "x");
    await fs.mkdir(path.join(dir, "agents/dir-agent.md"), { mode: 0o755 });
    for (const f of [
      "skills/loose-file.md",
      "agents/notes.txt",
      "agents/Upper.md",
    ]) {
      await fs.chmod(path.join(dir, f), 0o644);
    }
    await seedBatteries(fx.home, ["gsd-reviewers"], opts);
    expect(await listTree(claudeDir())).toEqual([
      "agents",
      "agents/gsd-code-reviewer.md",
      "agents/gsd-security-auditor.md",
      "settings.json",
      "skills",
      "skills/good-one",
    ]);
  });

  it("collision: the earlier pack in MANIFEST order wins, the later is dropped and logged", async () => {
    const later = fx.packDir("gsd-reviewers");
    await fs.mkdir(path.join(later, "skills/gstack-review"), {
      recursive: true,
      mode: 0o755,
    });
    await fs.chmod(path.join(later, "skills"), 0o755);
    const result = await seedBatteries(
      fx.home,
      ["gsd-reviewers", "gstack-review"],
      opts,
    );
    expect(result).toMatchObject({
      ok: true,
      packs: ["gstack-review", "gsd-reviewers"],
    });
    expect(
      await fs.realpath(path.join(claudeDir(), "skills/gstack-review")),
    ).toBe(
      path.join(
        await fs.realpath(fx.packDir("gstack-review")),
        "skills/gstack-review",
      ),
    );
    expect(logs).toContain(
      "batteries: drop skills/gstack-review from gsd-reviewers (already provided by gstack-review)",
    );
  });

  it("retry into the same HOME replaces a link and leaves a non-link alone", async () => {
    await seedBatteries(fx.home, ["gsd-reviewers"], opts);
    await fs.rm(path.join(claudeDir(), "agents/gsd-security-auditor.md"));
    await fs.writeFile(
      path.join(claudeDir(), "agents/gsd-security-auditor.md"),
      "mine",
    );
    const result = await seedBatteries(fx.home, ["gsd-reviewers"], opts);
    expect(result).toMatchObject({ ok: true, packs: ["gsd-reviewers"] });
    expect(
      (
        await fs.lstat(path.join(claudeDir(), "agents/gsd-code-reviewer.md"))
      ).isSymbolicLink(),
    ).toBe(true);
    expect(
      await fs.readFile(
        path.join(claudeDir(), "agents/gsd-security-auditor.md"),
        "utf8",
      ),
    ).toBe("mine");
    expect(logs).toContain(
      "batteries: keep existing agents/gsd-security-auditor.md (not a link)",
    );
  });

  it("grants .claude, skills, agents (directory) and settings.json (file) to the agent user on linux", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    await seedBatteries(fx.home, ["gstack-review", "gsd-reviewers"], {
      ...opts,
      agentUser: "agent",
      platform: "linux",
      aclExec: async (file, args) => {
        calls.push({ file, args });
      },
    });
    const byTarget = new Map(calls.map((c) => [c.args[2], c.args[1]]));
    expect(calls.every((c) => c.file === "/usr/bin/setfacl")).toBe(true);
    expect(byTarget.get(claudeDir())).toBe(
      `u:agent:${LINUX_DIR_REGRANT_RIGHTS}`,
    );
    expect(byTarget.get(path.join(claudeDir(), "skills"))).toBe(
      `u:agent:${LINUX_DIR_REGRANT_RIGHTS}`,
    );
    expect(byTarget.get(path.join(claudeDir(), "agents"))).toBe(
      `u:agent:${LINUX_DIR_REGRANT_RIGHTS}`,
    );
    expect(byTarget.get(path.join(claudeDir(), "settings.json"))).toBe(
      `u:agent:${LINUX_FILE_REGRANT_RIGHTS}`,
    );
  });

  it("no agent user ⇒ no setfacl call", async () => {
    const calls: string[] = [];
    await seedBatteries(fx.home, ["gstack-review"], {
      ...opts,
      agentUser: "",
      platform: "linux",
      aclExec: async (file) => {
        calls.push(file);
      },
    });
    expect(calls).toEqual([]);
  });

  it("cleanup of the HOME removes the links but never the ROOT targets", async () => {
    await seedBatteries(fx.home, ["gstack-review", "gsd-reviewers"], opts);
    await fs.rm(fx.home, { recursive: true, force: true });
    expect(
      (
        await fs.stat(
          path.join(fx.packDir("gstack-review"), "skills/gstack-review"),
        )
      ).isDirectory(),
    ).toBe(true);
    expect(
      (
        await fs.stat(
          path.join(fx.packDir("gsd-reviewers"), "agents/gsd-code-reviewer.md"),
        )
      ).isFile(),
    ).toBe(true);
  });

  it("logs ids, reasons and a hash prefix only — never the HOME path", async () => {
    await fs.chmod(fx.packDir("gstack-review"), 0o777);
    await seedBatteries(fx.home, ["gstack-review", "gsd-reviewers"], opts);
    for (const line of logs) {
      expect(line).not.toContain(fx.base);
      expect(line.startsWith("batteries: ")).toBe(true);
    }
  });
});

function hasCommand(name: string): boolean {
  try {
    execFileSync("bash", ["-c", `command -v ${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const PARITY_TOOLS = ["bash", "git", "jq"];
const missingTool = PARITY_TOOLS.find((t) => !hasCommand(t));

describe("seedBatteries hooksOff:false (phase 7, task runs)", () => {
  let fx: BatteriesFixture;
  let logs: string[];
  let opts: SeedBatteriesOptions;

  beforeEach(async () => {
    fx = await makeBatteriesFixture();
    logs = [];
    opts = {
      root: fx.root,
      repoRoot: fx.repoRoot,
      rootOwnerUid: UID,
      packOwnerUid: UID,
      log: (line) => logs.push(line),
      hooksOff: false,
    };
  });
  afterEach(async () => {
    await fx.cleanup();
  });

  const claudeDir = () => path.join(fx.home, ".claude");

  it("links the somnio-skills skills and writes NO settings.json; .claude is a 0700 dir", async () => {
    const result = await seedBatteries(fx.home, ["somnio-skills"], opts);
    expect(result).toEqual({
      ok: true,
      packs: ["somnio-skills"],
      manifestHash: fx.manifestHash,
      requires: ["github-read-token"],
    });
    expect(await listTree(claudeDir())).toEqual([
      "skills",
      "skills/dora-metrics",
      "skills/react-health-audit",
      "skills/security-audit",
    ]);
    const st = await fs.lstat(claudeDir());
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
  });

  it("a pre-existing settings.json is left byte-identical", async () => {
    await fs.mkdir(claudeDir(), { recursive: true, mode: 0o700 });
    const settings = path.join(claudeDir(), "settings.json");
    const bytes = '{"hooks":{"x":1}, "foo": true}\n';
    await fs.writeFile(settings, bytes, { mode: 0o644 });
    await seedBatteries(fx.home, ["somnio-skills"], opts);
    expect(await fs.readFile(settings, "utf8")).toBe(bytes);
    expect((await fs.stat(settings)).mode & 0o777).toBe(0o644);
  });

  it("install unavailable ⇒ no-manifest-hash, still no settings.json", async () => {
    await fs.rm(path.join(fx.root, "manifest.sha256"));
    const result = await seedBatteries(fx.home, ["somnio-skills"], opts);
    expect(result).toEqual({ ok: false, reason: "no-manifest-hash" });
    expect(await listTree(claudeDir())).toEqual([]);
  });

  it("grants .claude and skills (directory) and never touches settings.json on linux", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    await seedBatteries(fx.home, ["somnio-skills"], {
      ...opts,
      agentUser: "agent",
      platform: "linux",
      aclExec: async (file, args) => {
        calls.push({ file, args });
      },
    });
    const targets = calls.map((c) => c.args[2]);
    expect(targets).toContain(claudeDir());
    expect(targets).toContain(path.join(claudeDir(), "skills"));
    expect(targets).not.toContain(path.join(claudeDir(), "settings.json"));
  });

  it("the default (hooksOff absent) still writes disableAllHooks:true", async () => {
    const { hooksOff: _omit, ...reviewOpts } = opts;
    void _omit;
    await seedBatteries(fx.home, ["somnio-skills"], reviewOpts);
    expect(
      JSON.parse(
        await fs.readFile(path.join(claudeDir(), "settings.json"), "utf8"),
      ),
    ).toEqual({ disableAllHooks: true });
  });
});

describe("seedBatteries foregroundOnly (task runs)", () => {
  let fx: BatteriesFixture;
  let logs: string[];
  let opts: SeedBatteriesOptions;

  beforeEach(async () => {
    fx = await makeBatteriesFixture();
    logs = [];
    opts = {
      root: fx.root,
      repoRoot: fx.repoRoot,
      rootOwnerUid: UID,
      packOwnerUid: UID,
      log: (line) => logs.push(line),
      hooksOff: false,
      foregroundOnly: true,
    };
  });
  afterEach(async () => {
    await fx.cleanup();
  });

  const claudeDir = () => path.join(fx.home, ".claude");
  const settingsPath = () => path.join(claudeDir(), "settings.json");

  it("writes ONLY the foreground-only PreToolUse hooks, 0644, packs still linked", async () => {
    const result = await seedBatteries(fx.home, ["somnio-skills"], opts);
    expect(result).toMatchObject({ ok: true, packs: ["somnio-skills"] });
    expect(JSON.parse(await fs.readFile(settingsPath(), "utf8"))).toEqual({
      hooks: { PreToolUse: [...FOREGROUND_ONLY_PRE_TOOL_USE] },
    });
    expect((await fs.stat(settingsPath())).mode & 0o777).toBe(0o644);
    expect(await listTree(claudeDir())).toEqual([
      "settings.json",
      "skills",
      "skills/dora-metrics",
      "skills/react-health-audit",
      "skills/security-audit",
    ]);
    expect(logs.join("\n")).not.toContain("settings.json");
  });

  it("merges over an existing settings.json (keys + hooks kept), mode reset to 0644", async () => {
    await fs.mkdir(claudeDir(), { recursive: true, mode: 0o700 });
    const mine = {
      matcher: "Write",
      hooks: [{ type: "command", command: "x" }],
    };
    await fs.writeFile(
      settingsPath(),
      JSON.stringify({ model: "sonnet", hooks: { PreToolUse: [mine] } }),
      { mode: 0o600 },
    );
    await seedBatteries(fx.home, ["somnio-skills"], opts);
    expect(JSON.parse(await fs.readFile(settingsPath(), "utf8"))).toEqual({
      model: "sonnet",
      hooks: { PreToolUse: [mine, ...FOREGROUND_ONLY_PRE_TOOL_USE] },
    });
    expect((await fs.stat(settingsPath())).mode & 0o777).toBe(0o644);
  });

  it("a retry into the same HOME does not duplicate the hooks", async () => {
    await seedBatteries(fx.home, ["somnio-skills"], opts);
    const first = await fs.readFile(settingsPath(), "utf8");
    await seedBatteries(fx.home, ["somnio-skills"], opts);
    expect(await fs.readFile(settingsPath(), "utf8")).toBe(first);
  });

  it("installed even when the battery install is unavailable (a HOME write, not a pack)", async () => {
    await fs.rm(path.join(fx.root, "manifest.sha256"));
    const result = await seedBatteries(fx.home, ["somnio-skills"], opts);
    expect(result).toEqual({ ok: false, reason: "no-manifest-hash" });
    expect(await listTree(claudeDir())).toEqual(["settings.json"]);
  });

  it("re-grants settings.json (file) to the agent user on linux", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    await seedBatteries(fx.home, ["somnio-skills"], {
      ...opts,
      agentUser: "agent",
      platform: "linux",
      aclExec: async (file, args) => {
        calls.push({ file, args });
      },
    });
    const byTarget = new Map(calls.map((c) => [c.args[2], c.args[1]]));
    expect(byTarget.get(settingsPath())).toBe(
      `u:agent:${LINUX_FILE_REGRANT_RIGHTS}`,
    );
  });

  it("a review seed (hooksOff on) ignores foregroundOnly: settings byte-identical to today", async () => {
    const { hooksOff: _omit, ...reviewOpts } = opts;
    void _omit;
    await seedBatteries(fx.home, ["somnio-skills"], reviewOpts);
    expect(await fs.readFile(settingsPath(), "utf8")).toBe(
      '{"disableAllHooks":true}',
    );
  });
});

describe("seedForegroundOnly (non-review runs without packs)", () => {
  let fx: BatteriesFixture;
  beforeEach(async () => {
    fx = await makeBatteriesFixture();
  });
  afterEach(async () => {
    await fx.cleanup();
  });

  it("writes only the guard (0644) and links nothing; idempotent", async () => {
    const logs: string[] = [];
    const opts = { log: (line: string) => logs.push(line) };
    await seedForegroundOnly(fx.home, opts);
    const claudeDir = path.join(fx.home, ".claude");
    const settings = path.join(claudeDir, "settings.json");
    expect(await listTree(claudeDir)).toEqual(["settings.json"]);
    expect(JSON.parse(await fs.readFile(settings, "utf8"))).toEqual({
      hooks: { PreToolUse: [...FOREGROUND_ONLY_PRE_TOOL_USE] },
    });
    expect((await fs.stat(settings)).mode & 0o777).toBe(0o644);
    const first = await fs.readFile(settings, "utf8");
    await seedForegroundOnly(fx.home, opts);
    expect(await fs.readFile(settings, "utf8")).toBe(first);
    expect(logs).toEqual([]);
  });

  it("grants .claude (dir) and settings.json (file) to the agent user on linux", async () => {
    const calls: Array<{ args: string[] }> = [];
    await seedForegroundOnly(fx.home, {
      log: () => {},
      agentUser: "agent",
      platform: "linux",
      aclExec: async (_file, args) => {
        calls.push({ args });
      },
    });
    const targets = calls.map((c) => c.args[2]);
    expect(targets).toContain(path.join(fx.home, ".claude"));
    expect(targets).toContain(path.join(fx.home, ".claude", "settings.json"));
  });
});

describe("seedBatteries requires (phase 7)", () => {
  let fx: BatteriesFixture;
  let opts: SeedBatteriesOptions;

  beforeEach(async () => {
    fx = await makeBatteriesFixture();
    opts = {
      root: fx.root,
      repoRoot: fx.repoRoot,
      rootOwnerUid: UID,
      packOwnerUid: UID,
      log: () => undefined,
      hooksOff: false,
    };
  });
  afterEach(async () => {
    await fx.cleanup();
  });

  it("a contributing requiring pack surfaces requires on the ok result", async () => {
    expect(await seedBatteries(fx.home, ["somnio-skills"], opts)).toEqual({
      ok: true,
      packs: ["somnio-skills"],
      manifestHash: fx.manifestHash,
      requires: ["github-read-token"],
    });
  });

  it("no contributing pack requires anything: NO requires key", async () => {
    const result = await seedBatteries(fx.home, ["somnio-review"], opts);
    expect(result.ok).toBe(true);
    expect("requires" in result).toBe(false);
  });

  it("a requiring pack that is skipped contributes nothing", async () => {
    const result = await seedBatteries(fx.home, ["somnio-skills"], {
      ...opts,
      packOwnerUid: UID + 1,
    });
    expect(result).toEqual({
      ok: true,
      packs: [],
      manifestHash: fx.manifestHash,
    });
  });
});

describe("computeBatteriesManifestHash ⇔ install-batteries.sh write_manifest_hash (W3, executed)", () => {
  it.skipIf(missingTool !== undefined)(
    `matches the installer's own function byte for byte${missingTool ? ` (skipped: ${missingTool} missing)` : ""}`,
    async () => {
      const fx = await makeBatteriesFixture();
      try {
        const script = await fs.readFile(
          path.join(
            REAL_REPO_ROOT,
            "packages/worker/deploy/linux/install-batteries.sh",
          ),
          "utf8",
        );
        const matches = [
          ...script.matchAll(/^write_manifest_hash\(\) \{\n[\s\S]*?^\}$/gm),
        ];
        expect(matches).toHaveLength(1);
        const fn = matches[0]![0]; // length asserted on the line above

        const git = (...args: string[]) =>
          execFileSync(
            "git",
            [
              "-c",
              "commit.gpgsign=false",
              "-c",
              "core.hooksPath=/dev/null",
              "-c",
              "user.name=t",
              "-c",
              "user.email=t@example.invalid",
              "-C",
              fx.repoRoot,
              ...args,
            ],
            { stdio: "pipe" },
          );
        git("init", "-q");
        git("add", "-A");
        git("commit", "-q", "-m", "fixture");

        const installRoot = path.join(fx.base, "parity-root");
        await fs.mkdir(installRoot);
        const harness = [
          "set -euo pipefail",
          'HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"',
          'git_repo() { git -C "$REPO" "$@"; }',
          'if ! command -v sha256sum >/dev/null 2>&1; then sha256sum() { shasum -a 256 "$@"; }; fi',
          fn,
          "write_manifest_hash",
        ].join("\n");
        execFileSync("bash", ["-c", harness], {
          env: {
            ...process.env,
            ROOT: installRoot,
            REPO: fx.repoRoot,
            MANIFEST: path.join(fx.repoRoot, BATTERIES_MANIFEST_REPO_PATH),
          },
          stdio: "pipe",
        });
        const installerHash = (
          await fs.readFile(path.join(installRoot, "manifest.sha256"), "utf8")
        ).trim();

        const bytes = await fs.readFile(
          path.join(fx.repoRoot, BATTERIES_MANIFEST_REPO_PATH),
        );
        const ours = await computeBatteriesManifestHash(
          bytes,
          fx.manifest,
          fx.repoRoot,
        );
        expect(installerHash).toMatch(/^[0-9a-f]{64}$/);
        expect(ours).toBe(installerHash);
        expect(ours).toBe(fx.manifestHash);
      } finally {
        await fx.cleanup();
      }
    },
  );
});

describe("formatBatteriesLine", () => {
  const hash = "a".repeat(12) + "b".repeat(52);

  it("classic (not seeded)", () => {
    expect(formatBatteriesLine(undefined)).toBe("batteries: mode=classic");
  });

  it("orchestrated with packs", () => {
    expect(
      formatBatteriesLine({
        ok: true,
        packs: ["gstack-review", "gsd-reviewers"],
        manifestHash: hash,
      }),
    ).toBe(
      "batteries: mode=orchestrated packs=gstack-review,gsd-reviewers manifest=aaaaaaaaaaaa",
    );
  });

  it("orchestrated, manifest ok, zero packs", () => {
    expect(
      formatBatteriesLine({ ok: true, packs: [], manifestHash: hash }),
    ).toBe("batteries: mode=orchestrated packs=none manifest=aaaaaaaaaaaa");
  });

  it("unavailable", () => {
    expect(formatBatteriesLine({ ok: false, reason: "no-manifest-hash" })).toBe(
      "batteries: unavailable mode=orchestrated reason=no-manifest-hash",
    );
  });

  describe("with a task gate (phase 7, task runs)", () => {
    it.each(["task", "pr"] as const)(
      "seed, lane %s: packs, none, unavailable, not-seeded",
      (lane) => {
        const gate = { kind: "seed", lane } as const;
        expect(
          formatBatteriesLine(
            { ok: true, packs: ["somnio-skills"], manifestHash: hash },
            gate,
          ),
        ).toBe(
          `batteries: lane=${lane} packs=somnio-skills manifest=aaaaaaaaaaaa`,
        );
        expect(
          formatBatteriesLine(
            { ok: true, packs: [], manifestHash: hash },
            gate,
          ),
        ).toBe(`batteries: lane=${lane} packs=none manifest=aaaaaaaaaaaa`);
        expect(
          formatBatteriesLine({ ok: false, reason: "manifest-drift" }, gate),
        ).toBe(`batteries: unavailable lane=${lane} reason=manifest-drift`);
        expect(formatBatteriesLine(undefined, gate)).toBe(
          `batteries: unavailable lane=${lane} reason=not-seeded`,
        );
      },
    );

    it.each(["task", "pr"] as const)(
      "rejected, lane %s: task-agent-invalid whatever was seeded",
      (lane) => {
        const gate = { kind: "rejected", lane } as const;
        expect(formatBatteriesLine(undefined, gate)).toBe(
          `batteries: unavailable lane=${lane} reason=task-agent-invalid`,
        );
        expect(
          formatBatteriesLine(
            { ok: true, packs: ["gstack-review"], manifestHash: hash },
            gate,
          ),
        ).toBe(`batteries: unavailable lane=${lane} reason=task-agent-invalid`);
      },
    );

    it("rejected on the review lane and none keep today's review forms", () => {
      for (const gate of [
        { kind: "rejected", lane: "review" } as const,
        { kind: "none" } as const,
      ]) {
        expect(formatBatteriesLine(undefined, gate)).toBe(
          "batteries: mode=classic",
        );
        expect(
          formatBatteriesLine(
            { ok: true, packs: ["gstack-review"], manifestHash: hash },
            gate,
          ),
        ).toBe(
          "batteries: mode=orchestrated packs=gstack-review manifest=aaaaaaaaaaaa",
        );
      }
    });
  });
});

describe("seedBatteries harness packs (gstack, gsd, ruflo)", () => {
  let fx: BatteriesFixture;
  let hx: HarnessFixture;
  let logs: string[];
  let opts: SeedBatteriesOptions;

  beforeEach(async () => {
    fx = await makeBatteriesFixture();
    hx = await addHarnessInstall(fx);
    logs = [];
    opts = {
      root: fx.root,
      repoRoot: fx.repoRoot,
      rootOwnerUid: UID,
      packOwnerUid: UID,
      log: (line) => logs.push(line),
      hooksOff: false,
      foregroundOnly: true,
      nodeMajor: 24,
    };
  });
  afterEach(async () => {
    await fx.cleanup();
  });

  const claudeDir = () => path.join(fx.home, ".claude");
  const HARNESS = ["gstack", "gsd", "ruflo"];
  const readJson = async (file: string) =>
    JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  const breadcrumb = () =>
    readJson(path.join(fx.home, ".automata/batteries.json"));

  describe("review-lane fence: a hooks-off seed never links a harness pack", () => {
    it("hooksOff true: nothing harness is linked or read, each id logged review-lane", async () => {
      const result = await seedBatteries(
        fx.home,
        ["gstack-review", ...HARNESS],
        { ...opts, hooksOff: true },
      );
      expect(result).toEqual({
        ok: true,
        packs: ["gstack-review"],
        manifestHash: fx.manifestHash,
      });
      expect(await listTree(claudeDir())).toEqual([
        "settings.json",
        "skills",
        "skills/gstack-review",
      ]);
      for (const id of HARNESS) {
        expect(logs).toContain(`batteries: skip pack ${id} reason=review-lane`);
      }
      await expect(fs.lstat(path.join(fx.home, ".automata"))).rejects.toThrow();
      await expect(fs.lstat(path.join(fx.home, ".gstack"))).rejects.toThrow();
      expect(await readJson(path.join(claudeDir(), "settings.json"))).toEqual({
        disableAllHooks: true,
      });
    });

    it("hooksOff absent (the review default) is fenced the same way", async () => {
      const { hooksOff: _omit, ...reviewOpts } = opts;
      void _omit;
      const result = await seedBatteries(fx.home, HARNESS, reviewOpts);
      expect(result).toEqual({
        ok: true,
        packs: [],
        manifestHash: fx.manifestHash,
      });
      expect(await listTree(claudeDir())).toEqual(["settings.json"]);
      expect(logs.filter((l) => l.endsWith("reason=review-lane"))).toHaveLength(
        3,
      );
    });
  });

  it("task lane: links skills, agents (files AND subdirs), commands and gsd-core — never pack hooks or settings", async () => {
    const result = await seedBatteries(
      fx.home,
      ["somnio-skills", ...HARNESS],
      opts,
    );
    expect(result).toMatchObject({
      ok: true,
      packs: ["somnio-skills"],
      manifestHash: fx.manifestHash,
      harness: { ok: true, harnessHash: hx.harnessHash },
    });
    expect(await listTree(claudeDir())).toEqual([
      "agents",
      "agents/gsd-debugger.md",
      "agents/gsd-planner.compact.md",
      "agents/sub",
      "commands",
      "commands/gsd",
      "gsd-core",
      "settings.json",
      "skills",
      "skills/dora-metrics",
      "skills/gsd-debug",
      "skills/gstack",
      "skills/investigate",
      "skills/react-health-audit",
      "skills/security-audit",
    ]);
    const realGsd = await fs.realpath(hx.harnessPackDir("gsd"));
    expect(await fs.readlink(path.join(claudeDir(), "gsd-core"))).toBe(
      path.join(realGsd, "claude/gsd-core"),
    );
    // The in-pack symlink resolves to the skill dir inside the pack.
    expect(
      await fs.readFile(
        path.join(claudeDir(), "skills/investigate/SKILL.md"),
        "utf8",
      ),
    ).toContain("investigate");
    const harness = result.harness;
    if (!harness?.ok) throw new Error("expected a seeded harness");
    expect(harness.packs.map((p) => [p.id, p.linked])).toEqual([
      ["gstack", ["skills/gstack", "skills/investigate"]],
      [
        "gsd",
        [
          "skills/gsd-debug",
          "agents/gsd-debugger.md",
          "agents/gsd-planner.compact.md",
          "agents/sub",
          "commands/gsd",
          "gsd-core",
        ],
      ],
      ["ruflo", []],
    ]);
  });

  it("settings.json: foreground-only hooks + best-effort ruflo deny; no GSD statusLine or hooks", async () => {
    await seedBatteries(fx.home, HARNESS, opts);
    expect(await readJson(path.join(claudeDir(), "settings.json"))).toEqual({
      hooks: { PreToolUse: [...FOREGROUND_ONLY_PRE_TOOL_USE] },
      permissions: {
        deny: FIXTURE_FORBIDDEN_RUFLO_TOOLS.map((t) => `mcp__ruflo__${t}`),
      },
    });
  });

  it("settings.json merge keeps an existing deny list and dedupes on retry", async () => {
    await fs.mkdir(claudeDir(), { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(claudeDir(), "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash"], deny: ["WebFetch"] } }),
    );
    await seedBatteries(fx.home, HARNESS, opts);
    await seedBatteries(fx.home, HARNESS, opts);
    const settings = await readJson(path.join(claudeDir(), "settings.json"));
    expect(settings.permissions).toEqual({
      allow: ["Bash"],
      deny: [
        "WebFetch",
        ...FIXTURE_FORBIDDEN_RUFLO_TOOLS.map((t) => `mcp__ruflo__${t}`),
      ],
    });
  });

  it("no mcp-tools.json ⇒ no deny entries (the settings file stays today's)", async () => {
    await fs.rm(path.join(hx.harnessPackDir("ruflo"), "mcp-tools.json"));
    await seedBatteries(fx.home, ["ruflo"], opts);
    expect(await readJson(path.join(claudeDir(), "settings.json"))).toEqual({
      hooks: { PreToolUse: [...FOREGROUND_ONLY_PRE_TOOL_USE] },
    });
  });

  it("resolves {{packDir}} in env and the MCP command; the MCP entry carries no env", async () => {
    const result = await seedBatteries(fx.home, HARNESS, opts);
    const harness = result.harness;
    if (!harness?.ok) throw new Error("expected a seeded harness");
    const gstack = await fs.realpath(hx.harnessPackDir("gstack"));
    const ruflo = await fs.realpath(hx.harnessPackDir("ruflo"));
    expect(harness.packs[0]?.env).toEqual({
      GSTACK_SESSION_KIND: "spawned",
      PLAYWRIGHT_BROWSERS_PATH: `${gstack}/ms-playwright`,
    });
    expect(harness.packs[2]?.mcpServers).toEqual({
      ruflo: { command: `${ruflo}/bin/ruflo-mcp`, args: [] },
    });
    expect(JSON.stringify(harness)).not.toMatch(/TOKEN|KEY|SECRET/);
  });

  it("writes the breadcrumb and gstack config (0644) for the agent to read", async () => {
    await seedBatteries(fx.home, HARNESS, opts);
    const crumb = await breadcrumb();
    expect(crumb).toEqual({
      schemaVersion: 1,
      harness: {
        ok: true,
        hash: hx.harnessHash,
        packs: [
          {
            id: "gstack",
            pin: "df89475b1713d2480a5e266e0fd448201817d80e",
            linked: ["skills/gstack", "skills/investigate"],
            headlessSafe: ["investigate", "browse"],
            mcpServers: [],
          },
          expect.objectContaining({ id: "gsd", pin: "1.16.0" }),
          {
            id: "ruflo",
            pin: "3.56.7",
            linked: [],
            headlessSafe: [],
            mcpServers: ["ruflo"],
          },
        ],
      },
    });
    const config = path.join(fx.home, ".gstack/config.yaml");
    expect(await fs.readFile(config, "utf8")).toBe(
      "telemetry: off\nupdate_check: false\n",
    );
    for (const file of [
      config,
      path.join(fx.home, ".automata/batteries.json"),
    ]) {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o644);
    }
  });

  it("no gstack ⇒ no gstack config", async () => {
    await seedBatteries(fx.home, ["gsd"], opts);
    await expect(fs.lstat(path.join(fx.home, ".gstack"))).rejects.toThrow();
  });

  it("grants the breadcrumb/config dirs and files to the agent user on linux (after the chmod)", async () => {
    const calls: string[][] = [];
    await seedBatteries(fx.home, HARNESS, {
      ...opts,
      agentUser: "agent",
      platform: "linux",
      aclExec: async (_file, args) => {
        calls.push(args);
      },
    });
    const byTarget = new Map(calls.map((args) => [args[2], args[1]]));
    for (const [rel, rights] of [
      [".gstack", LINUX_DIR_REGRANT_RIGHTS],
      [".gstack/config.yaml", LINUX_FILE_REGRANT_RIGHTS],
      [".automata", LINUX_DIR_REGRANT_RIGHTS],
      [".automata/batteries.json", LINUX_FILE_REGRANT_RIGHTS],
      [".claude/commands", LINUX_DIR_REGRANT_RIGHTS],
    ] as const) {
      expect(byTarget.get(path.join(fx.home, rel))).toBe(`u:agent:${rights}`);
    }
  });

  describe("preflight: a failed harness check seeds no harness pack, review/somnio packs still seed", () => {
    async function expectHarnessUnavailable(reason: string) {
      const result = await seedBatteries(
        fx.home,
        ["somnio-skills", ...HARNESS],
        opts,
      );
      expect(result).toEqual({
        ok: true,
        packs: ["somnio-skills"],
        manifestHash: fx.manifestHash,
        requires: ["github-read-token"],
        harness: { ok: false, reason },
      });
      expect(await listTree(claudeDir())).toEqual([
        "settings.json",
        "skills",
        "skills/dora-metrics",
        "skills/react-health-audit",
        "skills/security-audit",
      ]);
      expect(logs).toContain(`batteries: harness unavailable reason=${reason}`);
      expect(await breadcrumb()).toEqual({
        schemaVersion: 1,
        harness: { ok: false, reason },
      });
    }

    it("no harness.sha256 ⇒ no-harness-hash", async () => {
      await fs.rm(path.join(fx.root, "harness.sha256"));
      await expectHarnessUnavailable("no-harness-hash");
    });

    it("only harness.sha256.invalid ⇒ harness-invalidated", async () => {
      await fs.rename(
        path.join(fx.root, "harness.sha256"),
        path.join(fx.root, "harness.sha256.invalid"),
      );
      await expectHarnessUnavailable("harness-invalidated");
    });

    it("harness.sha256 not 64-hex ⇒ harness-hash-malformed", async () => {
      await fs.writeFile(path.join(fx.root, "harness.sha256"), "abc\n");
      await expectHarnessUnavailable("harness-hash-malformed");
    });

    it("hash ≠ this checkout's harness.json ⇒ harness-drift", async () => {
      await fs.writeFile(
        path.join(fx.root, "harness.sha256"),
        `${"0".repeat(64)}\n`,
      );
      await expectHarnessUnavailable("harness-drift");
    });

    it("harness.json failing the guard ⇒ harness-manifest-invalid", async () => {
      await fs.writeFile(
        path.join(fx.repoRoot, HARNESS_MANIFEST_REPO_PATH),
        JSON.stringify({ schemaVersion: 2 }),
      );
      await expectHarnessUnavailable("harness-manifest-invalid");
    });

    it("the review install failing does not cost the harness packs", async () => {
      await fs.rm(path.join(fx.root, "manifest.sha256"));
      const result = await seedBatteries(
        fx.home,
        ["somnio-skills", "gsd"],
        opts,
      );
      expect(result).toMatchObject({
        ok: false,
        reason: "no-manifest-hash",
        harness: { ok: true, packs: [expect.objectContaining({ id: "gsd" })] },
      });
      const tree = await listTree(claudeDir());
      expect(tree).toContain("gsd-core");
      expect(tree).not.toContain("skills/dora-metrics");
    });
  });

  describe("per-pack preflight: the pack is skipped and logged, others seed", () => {
    async function expectSkipped(id: string, reason: string) {
      const result = await seedBatteries(fx.home, HARNESS, opts);
      const harness = result.harness;
      if (!harness?.ok) throw new Error("expected a seeded harness");
      expect(harness.packs.map((p) => p.id)).toEqual(
        HARNESS.filter((p) => p !== id),
      );
      expect(logs).toContain(`batteries: skip pack ${id} reason=${reason}`);
    }

    it("this process on another Node major ⇒ every pack node-mismatch", async () => {
      const result = await seedBatteries(fx.home, HARNESS, {
        ...opts,
        nodeMajor: 22,
      });
      expect(result.harness).toEqual({
        ok: true,
        harnessHash: hx.harnessHash,
        packs: [],
      });
      for (const id of HARNESS) {
        expect(logs).toContain(
          `batteries: skip pack ${id} reason=node-mismatch`,
        );
      }
    });

    it("a stamp built for another Node major ⇒ node-abi-mismatch", async () => {
      await fs.writeFile(
        path.join(hx.harnessPackDir("gsd"), ".stamp"),
        `stamp ${"b".repeat(64)}\nnode 22\n`,
      );
      await expectSkipped("gsd", "node-abi-mismatch");
    });

    it("no stamp ⇒ no-stamp; malformed stamp ⇒ stamp-malformed", async () => {
      await fs.rm(path.join(hx.harnessPackDir("gstack"), ".stamp"));
      await fs.writeFile(
        path.join(hx.harnessPackDir("gsd"), ".stamp"),
        "node 24\n",
      );
      await seedBatteries(fx.home, HARNESS, opts);
      expect(logs).toContain("batteries: skip pack gstack reason=no-stamp");
      expect(logs).toContain("batteries: skip pack gsd reason=stamp-malformed");
    });

    it("pack dir missing ⇒ missing", async () => {
      await fs.rm(hx.harnessPackDir("ruflo"), { recursive: true });
      await expectSkipped("ruflo", "missing");
    });

    it("a symlink escaping the pack ⇒ tree-invalid", async () => {
      await fs.symlink(
        fx.home,
        path.join(hx.harnessPackDir("gsd"), "claude/agents/escape"),
      );
      await expectSkipped("gsd", "tree-invalid");
    });

    it("a claude/ entry owned by another uid ⇒ not-root-owned (via the lstat seam)", async () => {
      // The walk runs under the pack's REAL dir (macOS tmp is a symlink).
      const victim = await fs.realpath(
        path.join(hx.harnessPackDir("gsd"), "claude/commands/gsd/debug.md"),
      );
      await expectSkippedWith("gsd", "not-root-owned", async (p) => {
        const st = await fs.lstat(p);
        return p === victim
          ? Object.assign(Object.create(st) as typeof st, { uid: UID + 1 })
          : st;
      });
    });

    it("the MCP wrapper missing ⇒ mcp-wrapper-missing", async () => {
      await fs.rm(path.join(hx.harnessPackDir("ruflo"), "bin/ruflo-mcp"));
      await expectSkipped("ruflo", "mcp-wrapper-missing");
    });

    it("an unparseable mcp-tools.json ⇒ mcp-tools-invalid", async () => {
      await fs.writeFile(
        path.join(hx.harnessPackDir("ruflo"), "mcp-tools.json"),
        '["ok", 7]',
      );
      await expectSkipped("ruflo", "mcp-tools-invalid");
    });

    async function expectSkippedWith(
      id: string,
      reason: string,
      lstat: NonNullable<SeedBatteriesOptions["lstat"]>,
    ) {
      opts = { ...opts, lstat };
      await expectSkipped(id, reason);
    }
  });

  it("collision: a review/somnio pack wins over a harness pack (first wins), logged", async () => {
    const dup = path.join(
      hx.harnessPackDir("gsd"),
      "claude/skills/security-audit",
    );
    await fs.mkdir(dup, { mode: 0o755 });
    await fs.writeFile(path.join(dup, "SKILL.md"), "---\nname: x\n---\n");
    await fs.chmod(path.join(dup, "SKILL.md"), 0o644);
    await seedBatteries(fx.home, ["somnio-skills", "gsd"], opts);
    expect(logs).toContain(
      "batteries: drop skills/security-audit from gsd (already provided by somnio-skills)",
    );
    expect(
      await fs.realpath(path.join(claudeDir(), "skills/security-audit")),
    ).toBe(
      path.join(
        await fs.realpath(fx.packDir("somnio-skills")),
        "skills/security-audit",
      ),
    );
  });

  it("unknown non-harness ids are still logged against batteries.json; harness ids are not", async () => {
    await seedBatteries(fx.home, ["nope", "gstack"], opts);
    expect(logs).toContain("batteries: skip pack nope reason=unknown-id");
    expect(logs.join("\n")).not.toContain("gstack reason=unknown-id");
  });

  it("formatBatteriesLine appends the harness hash and packs", async () => {
    const result = await seedBatteries(
      fx.home,
      ["somnio-skills", ...HARNESS],
      opts,
    );
    expect(formatBatteriesLine(result, { kind: "seed", lane: "task" })).toBe(
      `batteries: lane=task packs=somnio-skills manifest=${fx.manifestHash.slice(0, 12)} harness=${hx.harnessHash.slice(0, 12)} harness-packs=gstack,gsd,ruflo`,
    );
  });

  describe("harnessDoctorLine (worker boot)", () => {
    const doctorOpts = () => ({
      root: fx.root,
      repoRoot: fx.repoRoot,
      rootOwnerUid: UID,
      packOwnerUid: UID,
      nodeMajor: 24,
    });

    it("every pack ok", async () => {
      expect(await harnessDoctorLine(doctorOpts())).toBe(
        `harness: hash=${hx.harnessHash.slice(0, 12)} node=${process.versions.node} ok=gstack,gsd,ruflo`,
      );
    });

    it("names skipped packs with their reasons", async () => {
      await fs.rm(hx.harnessPackDir("gsd"), { recursive: true });
      expect(await harnessDoctorLine(doctorOpts())).toBe(
        `harness: hash=${hx.harnessHash.slice(0, 12)} node=${process.versions.node} ok=gstack,ruflo skipped=gsd(missing)`,
      );
    });

    it("an unavailable install, never a throw", async () => {
      await fs.rm(path.join(fx.root, "harness.sha256"));
      expect(await harnessDoctorLine(doctorOpts())).toBe(
        "harness: unavailable reason=no-harness-hash",
      );
      expect(
        await harnessDoctorLine({ ...doctorOpts(), root: "/nonexistent" }),
      ).toBe("harness: unavailable reason=root-not-trusted");
    });
  });
});
