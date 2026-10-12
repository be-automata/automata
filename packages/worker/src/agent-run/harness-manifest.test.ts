import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FORBIDDEN_NAMES } from "./batteries-manifest";
import {
  FORBIDDEN_MCP_TOOL_PREFIXES,
  findHarnessManifestError,
  frontmatterKeys,
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
        setupArgs: ["--host", "claude"],
        dependencies: [
          {
            name: "bun",
            version: "1.4.2",
            url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip",
            sha256: SHA256,
            license: "MIT",
          },
        ],
        nodeMajor: 24,
        env: { PLAYWRIGHT_BROWSERS_PATH: "{{packDir}}/ms-playwright" },
        headlessSafe: ["investigate"],
        frontmatterHookSkills: ["careful"],
      },
      {
        id: "gsd",
        class: "harness",
        kind: "npm-lock",
        package: "@opengsd/gsd-core",
        version: "1.16.0",
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
        license: "MIT",
        nodeMajor: 24,
        env: { MCP_TIMEOUT: "30000" },
        mcpServers: {
          ruflo: { command: "{{packDir}}/bin/ruflo-mcp", args: [] },
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

  it("rejects a pending lock pin before the installer defines it (PR3)", () => {
    expect(
      errorAfter((m) =>
        Object.assign(m.packs[1]!, { lockSha256: "PENDING-PR3" }),
      ),
    ).toContain("packs[1].lockSha256: unknown key");
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

  it.each(["$(id)", "a b", "x;y", "/abs{{packDir}}", "{{other}}/x"])(
    "rejects env value %j",
    (value) => {
      expect(
        errorAfter((m) =>
          Object.assign(m.packs[1]!, { env: { GSTACK_X: value } }),
        ),
      ).toContain("env.GSTACK_X");
    },
  );
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

describe("frontmatterKeys", () => {
  it("returns top-level keys only", () => {
    expect(
      frontmatterKeys(
        "---\nname: x\nhooks:\n  PreToolUse:\n    - matcher: Bash\nallowed-tools:\n  - Read\n---\nbody: no\n",
      ),
    ).toEqual(["name", "hooks", "allowed-tools"]);
  });

  it("handles CRLF and ignores a file without a closed leading block", () => {
    expect(frontmatterKeys("---\r\nname: x\r\n---\r\n")).toEqual(["name"]);
    expect(frontmatterKeys("name: x\n")).toEqual([]);
    expect(frontmatterKeys("---\nname: x\n")).toEqual([]);
  });
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

  it("does not police markdown inside node_modules (package data, never linked)", () => {
    write(
      "node_modules/@claude-flow/cli/.claude/agents/a.md",
      "---\nname: a\nhooks: {}\npermissionMode: plan\n---\n",
    );
    expect(check()).toEqual({ errors: [], discard: [] });
  });
});
