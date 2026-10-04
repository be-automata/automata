import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BATTERIES_MANIFEST_REPO_PATH,
  BATTERIES_OVERLAY_DIR,
  findBatteriesManifestError,
  isBatteriesManifest,
} from "./batteries-manifest";

/**
 * Pins the strict shape of packages/worker/deploy/batteries.json. The guard is
 * pure and dependency-free; install-batteries.sh re-checks the same shapes in
 * bash, and Phase 5's seeding reuses this parser.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA256 = "c".repeat(64);

interface Fixture {
  schemaVersion: number;
  packs: Array<Record<string, unknown>>;
  clis: Array<Record<string, unknown>>;
  dropped: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

function validFixture(): Fixture {
  return {
    schemaVersion: 1,
    packs: [
      {
        id: "upstream-pack",
        repo: "https://github.com/owner/repo",
        sha: SHA_A,
        license: "MIT",
        subpaths: [
          {
            src: "review/checklist.md",
            dest: "skills/upstream-pack/checklist.md",
            gitId: SHA_B,
          },
          { src: "LICENSE", dest: "LICENSE", gitId: SHA_B },
        ],
        overlays: [
          {
            from: `${BATTERIES_OVERLAY_DIR}upstream-pack/SKILL.md`,
            dest: "skills/upstream-pack/SKILL.md",
          },
        ],
      },
      {
        id: "self-pack",
        repo: "self",
        sha: SHA_B,
        license: "internal",
        subpaths: [
          {
            src: ".claude/skills/thing",
            dest: "skills/thing",
            gitId: SHA_A,
            exclude: ["references/skip.md"],
          },
          { src: "agents/x.md", dest: "agents/x.md", gitId: SHA_A },
        ],
      },
    ],
    clis: [
      {
        name: "toolx",
        version: "1.2.3",
        url: "https://github.com/o/toolx/releases/download/v1.2.3/toolx_1.2.3_linux_amd64.tar.gz",
        sha256: SHA256,
        member: "toolx",
        licenseMember: "LICENSE",
        license: "MIT",
        versionArgs: "--version",
      },
    ],
    dropped: [],
  };
}

type Mutator = (f: Fixture) => void;

function pack(f: Fixture, i: number): Record<string, unknown> {
  const p = f.packs[i];
  if (p === undefined) throw new Error(`fixture has no pack ${i}`);
  return p;
}

function cli(f: Fixture): Record<string, unknown> {
  const c = f.clis[0];
  if (c === undefined) throw new Error("fixture has no cli");
  return c;
}

function subpath(f: Fixture, i: number, j: number): Record<string, unknown> {
  const subs = pack(f, i).subpaths;
  if (!Array.isArray(subs)) throw new Error("fixture subpaths not an array");
  const s: unknown = subs[j];
  if (typeof s !== "object" || s === null) {
    throw new Error(`fixture has no subpath ${i}/${j}`);
  }
  return s as Record<string, unknown>;
}

function overlay(f: Fixture): Record<string, unknown> {
  const ovs = pack(f, 0).overlays;
  if (!Array.isArray(ovs)) throw new Error("fixture overlays not an array");
  const o: unknown = ovs[0];
  if (typeof o !== "object" || o === null) throw new Error("no overlay");
  return o as Record<string, unknown>;
}

function mutated(mutate: Mutator): Fixture {
  const f = structuredClone(validFixture());
  mutate(f);
  return f;
}

function expectRejected(mutate: Mutator, pathFragment: string): void {
  const f = mutated(mutate);
  const error = findBatteriesManifestError(f);
  expect(error, "expected a rejection").toBeDefined();
  expect(error).toContain(pathFragment);
  expect(isBatteriesManifest(f)).toBe(false);
}

describe("findBatteriesManifestError — valid input", () => {
  it("accepts a minimal fixture with a github pack, a self pack and one cli", () => {
    const f = validFixture();
    expect(findBatteriesManifestError(f)).toBeUndefined();
    expect(isBatteriesManifest(f)).toBe(true);
  });

  it("accepts the committed packages/worker/deploy/batteries.json", () => {
    const raw = fs.readFileSync(
      path.join(repoRoot, BATTERIES_MANIFEST_REPO_PATH),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    const error = findBatteriesManifestError(parsed);
    expect(error, error).toBeUndefined();
  });

  it("rejects non-objects", () => {
    expect(findBatteriesManifestError(null)).toBeDefined();
    expect(findBatteriesManifestError([])).toBeDefined();
    expect(findBatteriesManifestError("x")).toBeDefined();
  });
});

describe("findBatteriesManifestError — pins", () => {
  it.each<[string, Mutator, string]>([
    [
      "schemaVersion 2",
      (f) => {
        f.schemaVersion = 2;
      },
      "schemaVersion",
    ],
    [
      "missing packs",
      (f) => {
        delete (f as Record<string, unknown>).packs;
      },
      "packs",
    ],
    [
      "pack sha of 39 hex",
      (f) => {
        pack(f, 1).sha = "a".repeat(39);
      },
      "packs[1].sha",
    ],
    [
      "pack sha with uppercase hex",
      (f) => {
        pack(f, 0).sha = "A".repeat(40);
      },
      "packs[0].sha",
    ],
    [
      "gitId not 40-hex",
      (f) => {
        subpath(f, 0, 1).gitId = "deadbeef";
      },
      "packs[0].subpaths[1].gitId",
    ],
    [
      "cli sha256 of 63 hex",
      (f) => {
        cli(f).sha256 = "c".repeat(63);
      },
      "clis[0].sha256",
    ],
    [
      "http repo",
      (f) => {
        pack(f, 0).repo = "http://github.com/a/b";
      },
      "packs[0].repo",
    ],
    [
      "gitlab repo",
      (f) => {
        pack(f, 0).repo = "https://gitlab.com/a/b";
      },
      "packs[0].repo",
    ],
  ])("rejects %s", (_name, mutate, fragment) => {
    expectRejected(mutate, fragment);
  });

  it('accepts repo "self"', () => {
    const f = mutated((m) => {
      pack(m, 0).repo = "self";
    });
    expect(findBatteriesManifestError(f)).toBeUndefined();
  });
});

describe("findBatteriesManifestError — licenses and duplicates", () => {
  it.each<[string, Mutator, string]>([
    [
      "empty pack license",
      (f) => {
        pack(f, 0).license = "";
      },
      "packs[0].license",
    ],
    [
      "whitespace pack license",
      (f) => {
        pack(f, 1).license = "   ";
      },
      "packs[1].license",
    ],
    [
      "empty cli license",
      (f) => {
        cli(f).license = "";
      },
      "clis[0].license",
    ],
    [
      "duplicate pack id",
      (f) => {
        pack(f, 1).id = "upstream-pack";
      },
      "packs[1].id",
    ],
    [
      "duplicate cli name",
      (f) => {
        f.clis.push({ ...cli(f) });
      },
      "clis[1].name",
    ],
  ])("rejects %s", (_name, mutate, fragment) => {
    expectRejected(mutate, fragment);
  });
});

describe("findBatteriesManifestError — id, name and versionArgs shapes", () => {
  it.each(["Gstack", "-x", "a b", "a;rm", "a/b", ""])(
    "rejects pack id %j",
    (id) => {
      expectRejected((f) => {
        pack(f, 0).id = id;
      }, "packs[0].id");
    },
  );

  it.each(["Gstack", "-x", "a b", "a;rm", "a/b", ""])(
    "rejects cli name %j",
    (name) => {
      expectRejected((f) => {
        cli(f).name = name;
      }, "clis[0].name");
    },
  );

  it.each(["--version", "-version", "version"])(
    "accepts versionArgs %j",
    (versionArgs) => {
      const f = mutated((m) => {
        cli(m).versionArgs = versionArgs;
      });
      expect(findBatteriesManifestError(f)).toBeUndefined();
    },
  );

  it.each(["", "--ver sion", "--version;id", "$(id)", "---version", "-V"])(
    "rejects versionArgs %j",
    (versionArgs) => {
      expectRejected((f) => {
        cli(f).versionArgs = versionArgs;
      }, "clis[0].versionArgs");
    },
  );
});

describe("findBatteriesManifestError — cli release fields", () => {
  it.each<[string, Mutator, string]>([
    [
      "version with a v prefix",
      (f) => {
        cli(f).version = "v1.2.3";
      },
      "clis[0].version",
    ],
    [
      "two-part version",
      (f) => {
        cli(f).version = "1.2";
      },
      "clis[0].version",
    ],
    [
      "url off github",
      (f) => {
        cli(f).url =
          "https://example.com/o/toolx/releases/download/v1.2.3/toolx_linux.tar.gz";
      },
      "clis[0].url",
    ],
    [
      "url for another version",
      (f) => {
        cli(f).url =
          "https://github.com/o/toolx/releases/download/v9.9.9/toolx_linux.tar.gz";
      },
      "clis[0].url",
    ],
    [
      "url without linux",
      (f) => {
        cli(f).url =
          "https://github.com/o/toolx/releases/download/v1.2.3/toolx_darwin.tar.gz";
      },
      "clis[0].url",
    ],
    [
      "missing versionArgs",
      (f) => {
        delete cli(f).versionArgs;
      },
      "clis[0].versionArgs",
    ],
    [
      "empty member",
      (f) => {
        cli(f).member = "";
      },
      "clis[0].member",
    ],
    [
      "empty licenseMember",
      (f) => {
        cli(f).licenseMember = "";
      },
      "clis[0].licenseMember",
    ],
  ])("rejects %s", (_name, mutate, fragment) => {
    expectRejected(mutate, fragment);
  });
});

describe("findBatteriesManifestError — path traversal", () => {
  const BAD_PATHS = ["/etc/passwd", "../x", "a/../b", "a\\b", "", "a/.."];

  const targets: Array<[string, (f: Fixture, bad: string) => void, string]> = [
    [
      "subpath src",
      (f, bad) => {
        subpath(f, 0, 0).src = bad;
      },
      "packs[0].subpaths[0].src",
    ],
    [
      "subpath dest",
      (f, bad) => {
        subpath(f, 0, 0).dest = bad;
      },
      "packs[0].subpaths[0].dest",
    ],
    [
      "exclude entry",
      (f, bad) => {
        subpath(f, 1, 0).exclude = [bad];
      },
      "packs[1].subpaths[0].exclude[0]",
    ],
    [
      "overlay from",
      (f, bad) => {
        overlay(f).from = bad;
      },
      "packs[0].overlays[0].from",
    ],
    [
      "overlay dest",
      (f, bad) => {
        overlay(f).dest = bad;
      },
      "packs[0].overlays[0].dest",
    ],
    [
      "cli member",
      (f, bad) => {
        cli(f).member = bad;
      },
      "clis[0].member",
    ],
    [
      "cli licenseMember",
      (f, bad) => {
        cli(f).licenseMember = bad;
      },
      "clis[0].licenseMember",
    ],
  ];

  for (const [label, set, fragment] of targets) {
    it.each(BAD_PATHS)(`rejects ${label} %j`, (bad) => {
      expectRejected((f) => set(f, bad), fragment);
    });
  }
});

describe("findBatteriesManifestError — destinations and forbidden names", () => {
  it.each(["hooks/pre.sh", "settings.json", "bin/x", "skills", "agents/x.sh"])(
    "rejects dest %j outside PACK_DEST",
    (dest) => {
      expectRejected((f) => {
        subpath(f, 0, 0).dest = dest;
      }, "packs[0].subpaths[0].dest");
    },
  );

  it.each([
    "skills/p/hooks/pre.sh",
    "skills/p/bin/helper",
    "skills/p/.claude-plugin/x.md",
    "skills/p/settings.json",
    "skills/p/settings.local.json",
    "skills/p/.mcp.json",
    "skills/p/plugin.json",
  ])("rejects forbidden name in dest %j", (dest) => {
    expectRejected((f) => {
      subpath(f, 0, 0).dest = dest;
    }, "packs[0].subpaths[0].dest");
  });

  it.each([
    "hooks",
    "a/bin",
    ".claude-plugin/plugin.json",
    "x/settings.json",
    "x/settings.local.json",
    ".mcp.json",
    "plugin.json",
  ])("rejects forbidden name in src %j", (src) => {
    expectRejected((f) => {
      subpath(f, 0, 0).src = src;
    }, "packs[0].subpaths[0].src");
  });

  it("rejects an overlay from outside the overlay dir", () => {
    expectRejected((f) => {
      overlay(f).from = "packages/worker/src/x/SKILL.md";
    }, "packs[0].overlays[0].from");
  });

  it("rejects an overlay dest outside skills/", () => {
    expectRejected((f) => {
      overlay(f).dest = "agents/x.md";
    }, "packs[0].overlays[0].dest");
  });
});

describe("findBatteriesManifestError — strict keys", () => {
  it.each<[string, Mutator, string]>([
    [
      "top level",
      (f) => {
        f.extra = 1;
      },
      "extra",
    ],
    [
      "pack",
      (f) => {
        pack(f, 0).sha265 = SHA256;
      },
      "packs[0].sha265",
    ],
    [
      "subpath",
      (f) => {
        subpath(f, 0, 0).mode = "0755";
      },
      "packs[0].subpaths[0].mode",
    ],
    [
      "overlay",
      (f) => {
        overlay(f).chmod = "0755";
      },
      "packs[0].overlays[0].chmod",
    ],
    [
      "cli",
      (f) => {
        cli(f).sha265 = SHA256;
      },
      "clis[0].sha265",
    ],
  ])("rejects an unknown key on the %s", (_name, mutate, fragment) => {
    expectRejected(mutate, fragment);
  });
});
