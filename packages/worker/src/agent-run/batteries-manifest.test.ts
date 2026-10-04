import { describe, expect, it } from "vitest";

import {
  BATTERIES_OVERLAY_DIR,
  FORBIDDEN_NAMES,
  findBatteriesManifestError,
  isBatteriesManifest,
  type BatteriesManifest,
} from "./batteries-manifest";

/**
 * Pins the strict shape of packages/worker/deploy/batteries.json. The guard is
 * pure and dependency-free; install-batteries.sh re-checks the same shapes in
 * bash, and Phase 5's seeding reuses this parser. The committed manifest is
 * checked in deploy-assets.test.ts.
 *
 * Mutators index the fixture with `!`: validFixture() builds packs[0..1],
 * their subpaths[0..1], packs[0].overlays[0], packs[0].allowedHelperRefs[0]
 * and clis[0], so those elements always exist. Invalid values are written
 * with Object.assign / Reflect.deleteProperty, which the types allow.
 */

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA256 = "c".repeat(64);

function validFixture(): BatteriesManifest {
  return {
    schemaVersion: 1,
    forbiddenHelperTokens: ["helper/bin"],
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
        allowedHelperRefs: [
          {
            file: "skills/upstream-pack/checklist.md",
            ref: "~/helper/bin/ledger",
            count: 1,
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

type Mutator = (f: BatteriesManifest) => void;

function mutated(mutate: Mutator): BatteriesManifest {
  const f = validFixture();
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
      (f) => Object.assign(f, { schemaVersion: 2 }),
      "schemaVersion",
    ],
    ["missing packs", (f) => Reflect.deleteProperty(f, "packs"), "packs"],
    [
      "pack sha of 39 hex",
      (f) => {
        f.packs[1]!.sha = "a".repeat(39);
      },
      "packs[1].sha",
    ],
    [
      "pack sha with uppercase hex",
      (f) => {
        f.packs[0]!.sha = "A".repeat(40);
      },
      "packs[0].sha",
    ],
    [
      "gitId not 40-hex",
      (f) => {
        f.packs[0]!.subpaths[1]!.gitId = "deadbeef";
      },
      "packs[0].subpaths[1].gitId",
    ],
    [
      "cli sha256 of 63 hex",
      (f) => {
        f.clis[0]!.sha256 = "c".repeat(63);
      },
      "clis[0].sha256",
    ],
    [
      "http repo",
      (f) => {
        f.packs[0]!.repo = "http://github.com/a/b";
      },
      "packs[0].repo",
    ],
    [
      "gitlab repo",
      (f) => {
        f.packs[0]!.repo = "https://gitlab.com/a/b";
      },
      "packs[0].repo",
    ],
  ])("rejects %s", (_name, mutate, fragment) => {
    expectRejected(mutate, fragment);
  });

  it('accepts repo "self"', () => {
    const f = mutated((m) => {
      m.packs[0]!.repo = "self";
    });
    expect(findBatteriesManifestError(f)).toBeUndefined();
  });
});

describe("findBatteriesManifestError — licenses and duplicates", () => {
  it.each<[string, Mutator, string]>([
    [
      "empty pack license",
      (f) => {
        f.packs[0]!.license = "";
      },
      "packs[0].license",
    ],
    [
      "whitespace pack license",
      (f) => {
        f.packs[1]!.license = "   ";
      },
      "packs[1].license",
    ],
    [
      "empty cli license",
      (f) => {
        f.clis[0]!.license = "";
      },
      "clis[0].license",
    ],
    [
      "duplicate pack id",
      (f) => {
        f.packs[1]!.id = "upstream-pack";
      },
      "packs[1].id",
    ],
    [
      "duplicate cli name",
      (f) => {
        f.clis.push({ ...f.clis[0]! });
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
        f.packs[0]!.id = id;
      }, "packs[0].id");
    },
  );

  it.each(["Gstack", "-x", "a b", "a;rm", "a/b", ""])(
    "rejects cli name %j",
    (name) => {
      expectRejected((f) => {
        f.clis[0]!.name = name;
      }, "clis[0].name");
    },
  );

  it.each(["--version", "-version", "version"])(
    "accepts versionArgs %j",
    (versionArgs) => {
      const f = mutated((m) => {
        m.clis[0]!.versionArgs = versionArgs;
      });
      expect(findBatteriesManifestError(f)).toBeUndefined();
    },
  );

  it.each(["", "--ver sion", "--version;id", "$(id)", "---version", "-V"])(
    "rejects versionArgs %j",
    (versionArgs) => {
      expectRejected((f) => {
        f.clis[0]!.versionArgs = versionArgs;
      }, "clis[0].versionArgs");
    },
  );
});

describe("findBatteriesManifestError — cli release fields", () => {
  it.each<[string, Mutator, string]>([
    [
      "version with a v prefix",
      (f) => {
        f.clis[0]!.version = "v1.2.3";
      },
      "clis[0].version",
    ],
    [
      "two-part version",
      (f) => {
        f.clis[0]!.version = "1.2";
      },
      "clis[0].version",
    ],
    [
      "url off github",
      (f) => {
        f.clis[0]!.url =
          "https://example.com/o/toolx/releases/download/v1.2.3/toolx_linux.tar.gz";
      },
      "clis[0].url",
    ],
    [
      "url for another version",
      (f) => {
        f.clis[0]!.url =
          "https://github.com/o/toolx/releases/download/v9.9.9/toolx_linux.tar.gz";
      },
      "clis[0].url",
    ],
    [
      "url without linux",
      (f) => {
        f.clis[0]!.url =
          "https://github.com/o/toolx/releases/download/v1.2.3/toolx_darwin.tar.gz";
      },
      "clis[0].url",
    ],
    [
      "missing versionArgs",
      (f) => Reflect.deleteProperty(f.clis[0]!, "versionArgs"),
      "clis[0].versionArgs",
    ],
    [
      "empty member",
      (f) => {
        f.clis[0]!.member = "";
      },
      "clis[0].member",
    ],
    [
      "empty licenseMember",
      (f) => {
        f.clis[0]!.licenseMember = "";
      },
      "clis[0].licenseMember",
    ],
  ])("rejects %s", (_name, mutate, fragment) => {
    expectRejected(mutate, fragment);
  });
});

describe("findBatteriesManifestError — path traversal", () => {
  const BAD_PATHS = ["/etc/passwd", "../x", "a/../b", "a\\b", "", "a/.."];

  const targets: Array<
    [string, (f: BatteriesManifest, bad: string) => void, string]
  > = [
    [
      "subpath src",
      (f, bad) => {
        f.packs[0]!.subpaths[0]!.src = bad;
      },
      "packs[0].subpaths[0].src",
    ],
    [
      "subpath dest",
      (f, bad) => {
        f.packs[0]!.subpaths[0]!.dest = bad;
      },
      "packs[0].subpaths[0].dest",
    ],
    [
      "exclude entry",
      (f, bad) => {
        f.packs[1]!.subpaths[0]!.exclude = [bad];
      },
      "packs[1].subpaths[0].exclude[0]",
    ],
    [
      "overlay from",
      (f, bad) => {
        f.packs[0]!.overlays![0]!.from = bad;
      },
      "packs[0].overlays[0].from",
    ],
    [
      "overlay dest",
      (f, bad) => {
        f.packs[0]!.overlays![0]!.dest = bad;
      },
      "packs[0].overlays[0].dest",
    ],
    [
      "helper ref file",
      (f, bad) => {
        f.packs[0]!.allowedHelperRefs![0]!.file = bad;
      },
      "packs[0].allowedHelperRefs[0].file",
    ],
    [
      "cli member",
      (f, bad) => {
        f.clis[0]!.member = bad;
      },
      "clis[0].member",
    ],
    [
      "cli licenseMember",
      (f, bad) => {
        f.clis[0]!.licenseMember = bad;
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

describe("findBatteriesManifestError — control characters and backslashes", () => {
  // install-batteries.sh reads the manifest as jq @tsv rows split on tabs and
  // newlines, and @tsv escapes backslashes: either would change a value
  // between the check and its use. Its preflight rejects them first, in any
  // string; this guard must agree.
  it.each(["a\tb", "a\nb", "a\u0000b", "a\u007fb", "a\\b"])(
    "rejects %j in any string, even a free-text one",
    (bad) => {
      expectRejected((f) => {
        f.dropped.push({ name: "x", reason: bad });
      }, "dropped[0].reason");
    },
  );
});

describe("findBatteriesManifestError — destinations and forbidden names", () => {
  it.each(["hooks/pre.sh", "settings.json", "bin/x", "skills", "agents/x.sh"])(
    "rejects dest %j outside PACK_DEST",
    (dest) => {
      expectRejected((f) => {
        f.packs[0]!.subpaths[0]!.dest = dest;
      }, "packs[0].subpaths[0].dest");
    },
  );

  it.each([...FORBIDDEN_NAMES])("rejects forbidden name %j in dest", (name) => {
    expectRejected((f) => {
      f.packs[0]!.subpaths[0]!.dest = `skills/p/${name}/x.md`;
    }, "packs[0].subpaths[0].dest");
  });

  it.each([...FORBIDDEN_NAMES])("rejects forbidden name %j in src", (name) => {
    expectRejected((f) => {
      f.packs[0]!.subpaths[0]!.src = `x/${name}`;
    }, "packs[0].subpaths[0].src");
  });

  it("rejects an overlay from outside the overlay dir", () => {
    expectRejected((f) => {
      f.packs[0]!.overlays![0]!.from = "packages/worker/src/x/SKILL.md";
    }, "packs[0].overlays[0].from");
  });

  it("rejects an overlay dest outside skills/", () => {
    expectRejected((f) => {
      f.packs[0]!.overlays![0]!.dest = "agents/x.md";
    }, "packs[0].overlays[0].dest");
  });
});

describe("findBatteriesManifestError — helper tokens and allowlist", () => {
  it.each<[string, Mutator, string]>([
    [
      "missing forbiddenHelperTokens",
      (f) => Reflect.deleteProperty(f, "forbiddenHelperTokens"),
      "forbiddenHelperTokens",
    ],
    [
      "empty forbiddenHelperTokens",
      (f) => {
        f.forbiddenHelperTokens = [];
      },
      "forbiddenHelperTokens",
    ],
    [
      "blank token",
      (f) => {
        f.forbiddenHelperTokens = [" "];
      },
      "forbiddenHelperTokens[0]",
    ],
    [
      "count 0",
      (f) => {
        f.packs[0]!.allowedHelperRefs![0]!.count = 0;
      },
      "packs[0].allowedHelperRefs[0].count",
    ],
    [
      "fractional count",
      (f) => {
        f.packs[0]!.allowedHelperRefs![0]!.count = 1.5;
      },
      "packs[0].allowedHelperRefs[0].count",
    ],
    [
      "empty ref",
      (f) => {
        f.packs[0]!.allowedHelperRefs![0]!.ref = "";
      },
      "packs[0].allowedHelperRefs[0].ref",
    ],
    [
      "ref that names no forbidden token",
      (f) => {
        f.packs[0]!.allowedHelperRefs![0]!.ref = "harmless";
      },
      "packs[0].allowedHelperRefs[0].ref",
    ],
    [
      "file outside the pack layout",
      (f) => {
        f.packs[0]!.allowedHelperRefs![0]!.file = "notes/checklist.md";
      },
      "packs[0].allowedHelperRefs[0].file",
    ],
  ])("rejects %s", (_name, mutate, fragment) => {
    expectRejected(mutate, fragment);
  });

  it("allows a pack with no allowedHelperRefs", () => {
    const f = mutated((m) =>
      Reflect.deleteProperty(m.packs[0]!, "allowedHelperRefs"),
    );
    expect(findBatteriesManifestError(f)).toBeUndefined();
  });
});

describe("findBatteriesManifestError — strict keys", () => {
  it.each<[string, Mutator, string]>([
    ["top level", (f) => Object.assign(f, { extra: 1 }), "extra"],
    [
      "pack",
      (f) => Object.assign(f.packs[0]!, { sha265: SHA256 }),
      "packs[0].sha265",
    ],
    [
      "subpath",
      (f) => Object.assign(f.packs[0]!.subpaths[0]!, { mode: "0755" }),
      "packs[0].subpaths[0].mode",
    ],
    [
      "overlay",
      (f) => Object.assign(f.packs[0]!.overlays![0]!, { chmod: "0755" }),
      "packs[0].overlays[0].chmod",
    ],
    [
      "helper ref",
      (f) => Object.assign(f.packs[0]!.allowedHelperRefs![0]!, { regex: "x" }),
      "packs[0].allowedHelperRefs[0].regex",
    ],
    [
      "cli",
      (f) => Object.assign(f.clis[0]!, { sha265: SHA256 }),
      "clis[0].sha265",
    ],
  ])("rejects an unknown key on the %s", (_name, mutate, fragment) => {
    expectRejected(mutate, fragment);
  });
});
