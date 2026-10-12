import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FORBIDDEN_NAMES } from "./batteries-manifest";
import {
  FORBIDDEN_MCP_TOOL_PREFIXES,
  findHarnessManifestError,
  parseFrontmatter,
  validateHarnessPackTree,
  type HarnessGitSetupPack,
  type HarnessManifest,
  type HarnessNpmLockPack,
} from "./harness-manifest";

/**
 * Pins the strict shape of packages/worker/deploy/harness.json and the
 * harness tree profile. The committed manifest is checked in
 * deploy-assets.test.ts.
 *
 * Mutators index the fixture with `!`: validFixture() always builds the three
 * packs in HARNESS_PACK_IDS order. Invalid values are written with
 * Object.assign / Reflect.deleteProperty, which the types allow.
 */

const SHA_A = "a".repeat(40);
const SHA256 = "c".repeat(64);

function validFixture(): HarnessManifest {
  return {
    schemaVersion: 1,
    packs: [
      {
        id: "gstack",
        class: "harness",
        kind: "git-setup",
        repo: "https://github.com/owner/gstack",
        sha: SHA_A,
        license: "MIT",
        checkoutDir: "skills/gstack",
        setupArgs: ["--host", "claude"],
        setupEnv: { GSTACK_SKIP_ASIDE: "1" },
        preSetup: [["bin/gstack-config", "set", "telemetry", "off"]],
        discard: ["skills/*/.gstack-owned"],
        dependencies: [
          {
            name: "bun",
            version: "1.4.2",
            url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip",
            sha256: SHA256,
            license: "MIT",
          },
        ],
        browsers: [
          {
            name: "chromium-headless-shell",
            revision: "1234",
            version: "151.0.7922.34",
            url: "https://cdn.playwright.dev/builds/cft/151.0.7922.34/linux64/chrome-headless-shell-linux64.zip",
            sha256: SHA256,
            dir: "chromium_headless_shell-1234",
            executable: "chrome-headless-shell-linux64/chrome-headless-shell",
          },
        ],
        nodeMajor: 24,
        env: { PLAYWRIGHT_BROWSERS_PATH: "{{packDir}}/ms-playwright" },
        smoke: [["claude/skills/gstack/browse/dist/browse", "--help"]],
        headlessSafe: ["investigate"],
        frontmatterHookSkills: ["careful"],
      },
      {
        id: "gsd",
        class: "harness",
        kind: "npm-lock",
        package: "@opengsd/gsd-core",
        version: "1.16.0",
        lockOverlay: "packages/worker/deploy/batteries/gsd/package-lock.json",
        lockSha256: SHA256,
        packageJsonSha256: SHA256,
        postInstall: [
          "node_modules/@opengsd/gsd-core/bin/install.js",
          "--config-dir",
          "{{configDir}}",
        ],
        license: "MIT",
        nodeMajor: 24,
        env: {},
        headlessSafe: [],
        frontmatterHookSkills: [],
      },
      {
        id: "ruflo",
        class: "harness",
        kind: "npm-lock",
        package: "ruflo",
        version: "3.56.7",
        overrides: { "@claude-flow/cli": "3.56.7" },
        lockOverlay: "packages/worker/deploy/batteries/ruflo/package-lock.json",
        lockSha256: SHA256,
        packageJsonSha256: SHA256,
        lifecycleScripts: ["@claude-flow/cli"],
        prebuilds: [
          {
            path: "node_modules/better-sqlite3",
            url: "https://github.com/WiseLibs/better-sqlite3/releases/download/v12.11.1/better-sqlite3-v12.11.1-node-v137-linux-x64.tar.gz",
            sha256: SHA256,
            member: "build/Release/better_sqlite3.node",
          },
        ],
        warmup: [
          { tool: "memory_store", arguments: { key: "warm", value: "up" } },
        ],
        license: "MIT",
        nodeMajor: 24,
        env: { MCP_TIMEOUT: "30000" },
        mcpServers: {
          ruflo: { command: "{{packDir}}/bin/ruflo-mcp", args: [] },
        },
        mcpServe: {
          entrypoint: "node_modules/ruflo/bin/ruflo.js",
          args: ["mcp", "start"],
          env: { CLAUDE_FLOW_HEADLESS: "true" },
        },
        toolAllowlist: ["memory_store", "system_health"],
        headlessSafe: [],
        frontmatterHookSkills: [],
      },
    ],
  };
}

const gstackOf = (m: HarnessManifest) => m.packs[0]! as HarnessGitSetupPack;
const rufloOf = (m: HarnessManifest) => m.packs[2]! as HarnessNpmLockPack;

function errorAfter(mutate: (m: HarnessManifest) => void): string | undefined {
  const manifest = validFixture();
  mutate(manifest);
  return findHarnessManifestError(manifest);
}

describe("findHarnessManifestError — valid input", () => {
  it("accepts the fixture", () => {
    expect(findHarnessManifestError(validFixture())).toBeUndefined();
  });

  it("rejects non-objects and a wrong schemaVersion", () => {
    expect(findHarnessManifestError([])).toContain("JSON object");
    expect(errorAfter((m) => Object.assign(m, { schemaVersion: 2 }))).toContain(
      "schemaVersion",
    );
  });
});

describe("findHarnessManifestError — ids", () => {
  it("rejects a missing harness pack", () => {
    expect(errorAfter((m) => m.packs.pop())).toContain(
      "ids must be exactly gstack, gsd, ruflo",
    );
  });

  it("rejects a reordered list", () => {
    expect(errorAfter((m) => m.packs.reverse())).toContain("in that order");
  });

  it("rejects a review pack id", () => {
    expect(
      errorAfter((m) => Object.assign(m.packs[0]!, { id: "gstack-review" })),
    ).toContain("ids must be exactly");
  });

  it("rejects a duplicate id", () => {
    expect(
      errorAfter((m) => Object.assign(m.packs[1]!, { id: "gstack" })),
    ).toContain("duplicate");
  });

  it('requires class "harness" and a known kind', () => {
    expect(
      errorAfter((m) => Object.assign(m.packs[1]!, { class: "battery" })),
    ).toContain('class: must be "harness"');
    expect(
      errorAfter((m) => Object.assign(m.packs[1]!, { kind: "curl-pipe" })),
    ).toContain("kind: must be one of git-setup, npm-lock");
  });
});

describe("findHarnessManifestError — pins", () => {
  it.each(["df89475b", "A".repeat(40), "main"])(
    "rejects a non-40-hex sha %j",
    (sha) => {
      expect(errorAfter((m) => Object.assign(gstackOf(m), { sha }))).toContain(
        "packs[0].sha",
      );
    },
  );

  it.each(["latest", "^1.16.0", "1.16", "v1.16.0", "1.16.0-beta.1"])(
    "rejects a non-exact version %j",
    (version) => {
      expect(
        errorAfter((m) => Object.assign(m.packs[1]!, { version })),
      ).toContain("packs[1].version");
    },
  );

  it("rejects a non-exact override", () => {
    expect(
      errorAfter((m) =>
        Object.assign(rufloOf(m), {
          overrides: { "@claude-flow/cli": "latest" },
        }),
      ),
    ).toContain("overrides.@claude-flow/cli");
  });

  it("rejects a dependency sha256 that is not 64 hex", () => {
    expect(
      errorAfter((m) =>
        Object.assign(gstackOf(m).dependencies[0]!, { sha256: "c".repeat(63) }),
      ),
    ).toContain("dependencies[0].sha256");
  });

  it("rejects a dependency url for another version or platform", () => {
    expect(
      errorAfter((m) =>
        Object.assign(gstackOf(m).dependencies[0]!, {
          url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.1/bun-linux-x64.zip",
        }),
      ),
    ).toContain("dependencies[0].url");
    expect(
      errorAfter((m) =>
        Object.assign(gstackOf(m).dependencies[0]!, {
          url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-darwin-aarch64.zip",
        }),
      ),
    ).toContain("dependencies[0].url");
  });

  it("rejects a non-github repo", () => {
    expect(
      errorAfter((m) =>
        Object.assign(gstackOf(m), { repo: "https://gitlab.com/o/r" }),
      ),
    ).toContain("packs[0].repo");
  });

  it("rejects a setup arg that is more than one word", () => {
    expect(
      errorAfter((m) =>
        Object.assign(gstackOf(m), { setupArgs: ["--host claude"] }),
      ),
    ).toContain("setupArgs[0]");
  });

  it("rejects a nodeMajor below 20 or not an integer", () => {
    expect(
      errorAfter((m) => Object.assign(m.packs[1]!, { nodeMajor: 18 })),
    ).toContain("nodeMajor");
    expect(
      errorAfter((m) => Object.assign(m.packs[1]!, { nodeMajor: "24" })),
    ).toContain("nodeMajor");
  });
});

describe("findHarnessManifestError — strict keys", () => {
  it("rejects an unknown top-level key", () => {
    expect(errorAfter((m) => Object.assign(m, { extra: 1 }))).toContain(
      "extra: unknown key",
    );
  });

  it("rejects a placeholder lock pin (PR3 defines the key as REQUIRED)", () => {
    expect(
      errorAfter((m) =>
        Object.assign(m.packs[1]!, { lockSha256: "PENDING-PR3" }),
      ),
    ).toContain("packs[1].lockSha256: must match");
  });

  it("rejects git-setup keys on an npm-lock pack and vice versa", () => {
    expect(
      errorAfter((m) => Object.assign(m.packs[1]!, { sha: SHA_A })),
    ).toContain("packs[1].sha: unknown key");
    expect(
      errorAfter((m) => Object.assign(gstackOf(m), { package: "x" })),
    ).toContain("packs[0].package: unknown key");
  });

  it("rejects a missing required key", () => {
    expect(
      errorAfter((m) => Reflect.deleteProperty(m.packs[1]!, "headlessSafe")),
    ).toContain("headlessSafe");
  });

  it("rejects control characters anywhere", () => {
    expect(
      errorAfter((m) => Object.assign(m.packs[1]!, { license: "MIT\n" })),
    ).toContain("control character");
  });
});

describe("findHarnessManifestError — env", () => {
  it.each(["PATH", "LD_PRELOAD", "NODE_OPTIONS", "GITHUB_TOKEN", "gstack_x"])(
    "rejects env key %s",
    (key) => {
      expect(
        errorAfter((m) => Object.assign(m.packs[1]!, { env: { [key]: "1" } })),
      ).toContain("key must match");
    },
  );

  it.each([
    "$(id)",
    "a b",
    "x;y",
    "/abs{{packDir}}",
    "{{other}}/x",
    "{{packDir}}/../x",
    "{{packDir}}/a/../../b",
    "{{packDir}}/./x",
    "{{packDir}}//x",
    "{{packDir}}/",
    "{{packDir}}x",
    "/etc",
    "../x",
    "..",
    "a/b",
  ])("rejects env value %j", (value) => {
    expect(
      errorAfter((m) =>
        Object.assign(m.packs[1]!, { env: { GSTACK_X: value } }),
      ),
    ).toContain("env.GSTACK_X");
  });
});

describe("findHarnessManifestError — env values accepted", () => {
  it.each([
    "{{packDir}}/ms-playwright",
    "{{packDir}}/a/b.c",
    "{{packDir}}",
    "spawned",
    "30000",
    "1.2.3",
  ])("accepts env value %j", (value) => {
    expect(
      errorAfter((m) =>
        Object.assign(m.packs[1]!, { env: { GSTACK_X: value } }),
      ),
    ).toBeUndefined();
  });
});

describe("findHarnessManifestError — mcpServers and toolAllowlist", () => {
  it("requires a tool allowlist with mcpServers", () => {
    expect(
      errorAfter((m) => Reflect.deleteProperty(rufloOf(m), "toolAllowlist")),
    ).toContain("required with mcpServers");
  });

  it("rejects a tool allowlist without mcpServers", () => {
    expect(
      errorAfter((m) =>
        Object.assign(m.packs[1]!, { toolAllowlist: ["memory_store"] }),
      ),
    ).toContain("only a pack with mcpServers");
  });

  it.each([
    "agent_spawn",
    "swarm_init",
    "hive-mind_spawn",
    "managed_agent_create",
    "wasm_agent_create",
    "federation_bbs_publish",
    "x_federation_publish",
    "transfer_store-download",
    "http_fetch",
    "terminal_execute",
    "github_pr_manage",
    "browser_act",
  ])("rejects the forbidden tool %s", (tool) => {
    expect(
      errorAfter((m) =>
        Object.assign(rufloOf(m), { toolAllowlist: ["memory_store", tool] }),
      ),
    ).toContain("toolAllowlist[1]");
  });

  it("names every forbidden prefix", () => {
    expect(FORBIDDEN_MCP_TOOL_PREFIXES).toEqual([
      "agent_",
      "swarm_",
      "hive-mind_",
      "managed_agent_",
      "wasm_agent_",
      "federation_",
      "x_federation_",
      "transfer_",
      "http_fetch",
      "terminal_",
      "github_",
      "browser_",
    ]);
  });

  it("rejects an empty or duplicate allowlist", () => {
    expect(
      errorAfter((m) => Object.assign(rufloOf(m), { toolAllowlist: [] })),
    ).toContain("must not be empty");
    expect(
      errorAfter((m) =>
        Object.assign(rufloOf(m), {
          toolAllowlist: ["memory_store", "memory_store"],
        }),
      ),
    ).toContain("duplicate");
  });

  it.each(["/usr/bin/npx", "npx", "{{packDir}}/../x", "{{packDir}}/"])(
    "rejects an MCP command outside the pack: %j",
    (command) => {
      expect(
        errorAfter((m) =>
          Object.assign(rufloOf(m), {
            mcpServers: { ruflo: { command, args: [] } },
          }),
        ),
      ).toContain("mcpServers.ruflo.command");
    },
  );

  it("rejects an env key on an MCP server (the wrapper owns its env)", () => {
    expect(
      errorAfter((m) =>
        Object.assign(rufloOf(m), {
          mcpServers: {
            ruflo: { command: "{{packDir}}/bin/ruflo-mcp", args: [], env: {} },
          },
        }),
      ),
    ).toContain("mcpServers.ruflo.env: unknown key");
  });
});

describe("FORBIDDEN_NAMES (review profile) is unchanged", () => {
  it("still lists every hook/bin/plugin/settings surface", () => {
    expect(FORBIDDEN_NAMES).toEqual([
      "hooks",
      "bin",
      ".claude-plugin",
      "settings.json",
      "settings.local.json",
      ".mcp.json",
      "plugin.json",
    ]);
  });
});

describe("parseFrontmatter", () => {
  it("returns top-level keys only", () => {
    expect(
      parseFrontmatter(
        "---\nname: x\nhooks:\n  PreToolUse:\n    - matcher: Bash\nallowed-tools:\n  - Read\n---\nbody: no\n",
      ),
    ).toEqual({ keys: ["name", "hooks", "allowed-tools"], opaque: false });
  });

  it("ignores a file without a leading fence", () => {
    expect(parseFrontmatter("name: x\n")).toEqual({ keys: [], opaque: false });
    expect(parseFrontmatter("")).toEqual({ keys: [], opaque: false });
  });

  it.each([
    ["CRLF", "---\r\nhooks: x\r\n---\r\n"],
    ["bare CR", "---\rhooks: x\r---\r"],
    ["a leading BOM", "\uFEFF---\nhooks: x\n---\n"],
    ["trailing blanks on both fences", "--- \nhooks: x\n---\t\n"],
  ])("reads the keys of a block with %s", (_name, text) => {
    expect(parseFrontmatter(text)).toEqual({ keys: ["hooks"], opaque: false });
  });

  it("marks a first line that starts with --- but is no fence as opaque", () => {
    expect(parseFrontmatter("---x\nhooks: x\n---\n").opaque).toBe(true);
  });

  it("marks an unterminated block as opaque, keeping the keys it saw", () => {
    expect(parseFrontmatter("---\nhooks: x\n")).toEqual({
      keys: ["hooks"],
      opaque: true,
    });
  });

  it.each([
    ['"mcpServers": {}', "mcpServers"],
    ["'hooks':", "hooks"],
    ['"permissionMode" : plan', "permissionMode"],
    ["hooks :", "hooks"],
  ])("unquotes the key of %j", (line, key) => {
    expect(parseFrontmatter(`---\n${line}\n---\n`)).toEqual({
      keys: [key],
      opaque: false,
    });
  });

  it("never reads an indented nested key as a top-level one", () => {
    expect(
      parseFrontmatter(
        '---\nmetadata:\n  hooks: x\n  "mcpServers": y\n\tpermissionMode: z\n---\n',
      ),
    ).toEqual({ keys: ["metadata"], opaque: false });
  });

  it("skips comments, blank lines and top-level list items", () => {
    expect(parseFrontmatter("---\n# hooks: no\n\nname: x\n- a\n---\n")).toEqual(
      { keys: ["name"], opaque: false },
    );
  });

  it.each(["{hooks: {Stop: []}}", "? hooks", "<<: *grants", "\"hooks': x"])(
    "marks %j as opaque",
    (line) => {
      expect(parseFrontmatter(`---\nname: x\n${line}\n---\n`).opaque).toBe(
        true,
      );
    },
  );
});

describe("validateHarnessPackTree", () => {
  let root: string;
  let packDir: string;
  const write = (rel: string, text = "x\n") => {
    const abs = path.join(packDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  const check = (hookSkills: string[] = []) =>
    validateHarnessPackTree(packDir, { frontmatterHookSkills: hookSkills });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-tree-"));
    packDir = path.join(root, "gstack@abc");
    fs.mkdirSync(packDir);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("accepts bin/, hooks/ and helper references (no forbiddenHelperTokens)", () => {
    write("bin/gstack-config", "#!/bin/sh\n~/.claude/skills/gstack/bin/x\n");
    write("hooks/check.sh");
    write("investigate/SKILL.md", "---\nname: investigate\n---\ngstack/bin\n");
    expect(check()).toEqual({ errors: [], discard: [] });
  });

  it("accepts an in-pack symlink, relative or absolute", () => {
    write("browse/dist/browse");
    fs.symlinkSync("browse/dist/browse", path.join(packDir, "browse-link"));
    fs.mkdirSync(path.join(packDir, "bin"));
    fs.symlinkSync(
      path.join(packDir, "browse"),
      path.join(packDir, "bin", "browse-dir"),
    );
    expect(check().errors).toEqual([]);
  });

  it("accepts a pack reached through a symlinked root", () => {
    write("a.txt");
    fs.symlinkSync("a.txt", path.join(packDir, "b"));
    const alias = path.join(root, "alias");
    fs.symlinkSync(packDir, alias);
    expect(
      validateHarnessPackTree(alias, { frontmatterHookSkills: [] }).errors,
    ).toEqual([]);
  });

  it("rejects a symlink escaping the pack, including via a sibling prefix", () => {
    write("ok.txt");
    fs.writeFileSync(path.join(root, "outside.txt"), "x");
    fs.mkdirSync(path.join(root, "gstack@abc-evil"));
    fs.writeFileSync(path.join(root, "gstack@abc-evil", "f"), "x");
    fs.symlinkSync("../outside.txt", path.join(packDir, "up"));
    fs.symlinkSync("/etc", path.join(packDir, "etc"));
    fs.symlinkSync("../gstack@abc-evil/f", path.join(packDir, "sibling"));
    fs.symlinkSync(".", path.join(packDir, "self"));
    expect(check().errors).toEqual([
      "etc: symlink escapes the pack dir",
      "self: symlink escapes the pack dir",
      "sibling: symlink escapes the pack dir",
      "up: symlink escapes the pack dir",
    ]);
  });

  it("rejects a dangling symlink and never follows a link into a directory", () => {
    fs.symlinkSync("missing", path.join(packDir, "gone"));
    fs.mkdirSync(path.join(root, "out"));
    fs.writeFileSync(
      path.join(root, "out", "SKILL.md"),
      "---\npermissionMode: bypassPermissions\n---\n",
    );
    fs.symlinkSync(path.join(root, "out"), path.join(packDir, "outdir"));
    expect(check().errors).toEqual([
      "gone: dangling symlink",
      "outdir: symlink escapes the pack dir",
    ]);
  });

  it("reports upstream settings.json/.mcp.json as discard, not errors", () => {
    write("settings.json", "{}");
    write(".mcp.json", "{}");
    write("claude/settings.local.json", "{}");
    write("node_modules/pkg/settings.json", "{}");
    expect(check()).toEqual({
      errors: [],
      discard: [".mcp.json", "claude/settings.local.json", "settings.json"],
    });
  });

  it("allows allowed-tools anywhere and hooks only for allowlisted skills", () => {
    write(
      "careful/SKILL.md",
      "---\nname: careful\nallowed-tools:\n  - Bash\nhooks:\n  PreToolUse: []\n---\n",
    );
    write("ship/SKILL.md", "---\nname: ship\nhooks:\n  Stop: []\n---\n");
    write("agents/x.md", "---\nname: x\nhooks:\n  Stop: []\n---\n");
    expect(check(["careful"]).errors).toEqual([
      "agents/x.md: frontmatter declares hooks outside frontmatterHookSkills",
      "ship/SKILL.md: frontmatter declares hooks outside frontmatterHookSkills",
    ]);
  });

  it("rejects mcpServers and permissionMode even for an allowlisted skill", () => {
    write(
      "careful/SKILL.md",
      "---\nname: careful\nmcpServers:\n  x: {}\npermissionMode: plan\n---\n",
    );
    expect(check(["careful"]).errors).toEqual([
      "careful/SKILL.md: frontmatter declares mcpServers",
      "careful/SKILL.md: frontmatter declares permissionMode",
    ]);
  });

  it.each([
    [
      '"mcpServers":\n  x: {}',
      "careful/SKILL.md: frontmatter declares mcpServers",
    ],
    [
      "'permissionMode': plan",
      "careful/SKILL.md: frontmatter declares permissionMode",
    ],
    [
      "'hooks':\n  Stop: []",
      "ship/SKILL.md: frontmatter declares hooks outside frontmatterHookSkills",
    ],
    [
      '"hooks" :\n  Stop: []',
      "ship/SKILL.md: frontmatter declares hooks outside frontmatterHookSkills",
    ],
    [
      '"hooks":\n  Stop: []',
      "ship/SKILL.md: frontmatter declares hooks outside frontmatterHookSkills",
    ],
    [
      "hooks :\n  Stop: []",
      "ship/SKILL.md: frontmatter declares hooks outside frontmatterHookSkills",
    ],
    [
      "'mcpServers':\n  x: {}",
      "careful/SKILL.md: frontmatter declares mcpServers",
    ],
    [
      '"permissionMode" : plan',
      "careful/SKILL.md: frontmatter declares permissionMode",
    ],
  ])("rejects the quoted key in %j", (block, error) => {
    const skill = error.split("/")[0]!;
    write(`${skill}/SKILL.md`, `---\nname: ${skill}\n${block}\n---\n`);
    expect(check(["careful"]).errors).toEqual([error]);
  });

  it.each([
    [
      "a fence with trailing blanks",
      "--- \nname: ship\nhooks:\n  Stop: []\n---\n",
    ],
    ["a leading BOM", "\uFEFF---\nname: ship\nhooks:\n  Stop: []\n---\n"],
    [
      "CRLF line endings",
      "---\r\nname: ship\r\nhooks:\r\n  Stop: []\r\n---\r\n",
    ],
  ])("rejects hooks behind %s", (_name, text) => {
    write("ship/SKILL.md", text);
    expect(check(["careful"]).errors).toEqual([
      "ship/SKILL.md: frontmatter declares hooks outside frontmatterHookSkills",
    ]);
  });

  it.each([
    ["a ---x first line", "---x\nname: ship\nhooks:\n  Stop: []\n---\n"],
    ["an unterminated block", "---\nname: ship\nmcpServers:\n  x: {}\n"],
  ])("fails closed on %s", (_name, text) => {
    write("ship/SKILL.md", text);
    expect(check(["careful"]).errors).toContain(
      "ship/SKILL.md: frontmatter has a top-level line that is not a plain key",
    );
  });

  it("fails closed on a flow-style frontmatter line, even for an allowlisted skill", () => {
    write("careful/SKILL.md", "---\nname: careful\n{hooks: {Stop: []}}\n---\n");
    expect(check(["careful"]).errors).toEqual([
      "careful/SKILL.md: frontmatter has a top-level line that is not a plain key",
    ]);
  });

  it("checks an in-pack symlinked .md under the LINK's skill attribution", () => {
    write(
      "careful/real.md",
      "---\nname: careful\nhooks:\n  PreToolUse: []\n---\n",
    );
    fs.mkdirSync(path.join(packDir, "ship"));
    fs.symlinkSync(
      "../careful/real.md",
      path.join(packDir, "ship", "SKILL.md"),
    );
    fs.mkdirSync(path.join(packDir, "guard"));
    fs.symlinkSync(
      "../careful/real.md",
      path.join(packDir, "guard", "SKILL.md"),
    );
    // careful/real.md itself is not a SKILL.md: its own hooks are refused too.
    expect(check(["careful", "guard"]).errors).toEqual([
      "careful/real.md: frontmatter declares hooks outside frontmatterHookSkills",
      "ship/SKILL.md: frontmatter declares hooks outside frontmatterHookSkills",
    ]);
  });

  it("checks a symlinked .md target that is not itself named .md", () => {
    write("data/notes.txt", "---\nname: x\npermissionMode: plan\n---\n");
    fs.symlinkSync("data/notes.txt", path.join(packDir, "README.md"));
    expect(check().errors).toEqual([
      "README.md: frontmatter declares permissionMode",
    ]);
  });

  it("ignores a symlinked .md that points at a directory", () => {
    fs.mkdirSync(path.join(packDir, "docs"));
    fs.symlinkSync("docs", path.join(packDir, "docs.md"));
    expect(check().errors).toEqual([]);
  });

  it.each(["SKILL.MD", "notes.Md"])(
    "polices an upper- or mixed-case %s file",
    (name) => {
      write(`ship/${name}`, "---\nname: ship\nmcpServers:\n  x: {}\n---\n");
      expect(check().errors).toEqual([
        `ship/${name}: frontmatter declares mcpServers`,
      ]);
    },
  );

  it("does not police markdown inside node_modules (package data, never linked)", () => {
    write(
      "node_modules/@claude-flow/cli/.claude/agents/a.md",
      "---\nname: a\nhooks: {}\npermissionMode: plan\n---\n",
    );
    expect(check()).toEqual({ errors: [], discard: [] });
  });
});

describe("findHarnessManifestError — installer keys (PR3)", () => {
  it("requires the npm-lock lock pins, under batteries/<id>/", () => {
    expect(
      errorAfter((m) => Reflect.deleteProperty(m.packs[1]!, "lockOverlay")),
    ).toContain("packs[1].lockOverlay");
    expect(
      errorAfter((m) =>
        Object.assign(m.packs[1]!, {
          lockOverlay:
            "packages/worker/deploy/batteries/ruflo/package-lock.json",
        }),
      ),
    ).toContain("packs[1].lockOverlay: must be under");
    expect(
      errorAfter((m) => Object.assign(m.packs[2]!, { lockSha256: "abc" })),
    ).toContain("packs[2].lockSha256");
    expect(
      errorAfter((m) =>
        Reflect.deleteProperty(m.packs[2]!, "packageJsonSha256"),
      ),
    ).toContain("packs[2].packageJsonSha256");
  });

  it("requires the git-setup build keys", () => {
    for (const key of ["checkoutDir", "setupEnv", "preSetup", "browsers"]) {
      expect(
        errorAfter((m) => Reflect.deleteProperty(gstackOf(m), key)),
        key,
      ).toContain(`packs[0].${key}`);
    }
  });

  it("pins browsers to a Chrome-for-Testing zip of their own version", () => {
    expect(
      errorAfter((m) =>
        Object.assign(gstackOf(m).browsers[0]!, {
          url: "https://example.com/chrome-linux64.zip",
        }),
      ),
    ).toContain("browsers[0].url");
    expect(
      errorAfter((m) =>
        Object.assign(gstackOf(m).browsers[0]!, { dir: "chromium-999" }),
      ),
    ).toContain("browsers[0].dir");
    expect(
      errorAfter((m) =>
        Object.assign(gstackOf(m).env, { PLAYWRIGHT_BROWSERS_PATH: "x" }),
      ),
    ).toContain("PLAYWRIGHT_BROWSERS_PATH");
  });

  it("rejects build env outside its prefixes and argv words with shell syntax", () => {
    expect(
      errorAfter((m) => Object.assign(gstackOf(m).setupEnv, { PATH: "/x" })),
    ).toContain("setupEnv.PATH");
    expect(
      errorAfter((m) =>
        Object.assign(gstackOf(m), { preSetup: [["bin/x", "$(id)"]] }),
      ),
    ).toContain("preSetup[0][1]");
    expect(
      errorAfter((m) =>
        Object.assign(gstackOf(m), { preSetup: [["/bin/sh", "-c"]] }),
      ),
    ).toContain("preSetup[0][0]");
    expect(
      errorAfter((m) => Object.assign(gstackOf(m), { smoke: [["sh", ";"]] })),
    ).toContain("smoke[0][1]");
  });

  it("accepts a * segment in discard, and nothing else glob-like", () => {
    expect(
      errorAfter((m) => Object.assign(gstackOf(m), { discard: ["skills/*"] })),
    ).toBeUndefined();
    expect(
      errorAfter((m) => Object.assign(gstackOf(m), { discard: ["../x"] })),
    ).toContain("discard[0]");
    expect(
      errorAfter((m) => Object.assign(gstackOf(m), { discard: ["a*b"] })),
    ).toContain("discard[0]");
  });

  it("pins prebuilds to a node-v<abi>-linux-x64 release asset", () => {
    expect(
      errorAfter((m) =>
        Object.assign(rufloOf(m).prebuilds![0]!, {
          url: "https://example.com/x-node-v137-linux-x64.tar.gz",
        }),
      ),
    ).toContain("prebuilds[0].url");
    expect(
      errorAfter((m) =>
        Object.assign(rufloOf(m).prebuilds![0]!, { path: "lib/x" }),
      ),
    ).toContain("prebuilds[0].path");
  });

  it("warms up only allowlisted tools", () => {
    expect(
      errorAfter((m) =>
        Object.assign(rufloOf(m), {
          warmup: [{ tool: "agent_spawn", arguments: {} }],
        }),
      ),
    ).toContain("warmup[0].tool");
  });

  it("requires mcpServe exactly with mcpServers", () => {
    expect(
      errorAfter((m) => Reflect.deleteProperty(rufloOf(m), "mcpServe")),
    ).toContain("mcpServe: required with mcpServers");
    expect(
      errorAfter((m) =>
        Object.assign(m.packs[1]!, {
          mcpServe: { entrypoint: "x.js", args: [], env: {} },
        }),
      ),
    ).toContain("packs[1].mcpServe: only a pack with mcpServers");
    expect(
      errorAfter((m) =>
        Object.assign(rufloOf(m).mcpServe!.env, { NODE_OPTIONS: "--x" }),
      ),
    ).toContain("mcpServe.env.NODE_OPTIONS");
  });
});
