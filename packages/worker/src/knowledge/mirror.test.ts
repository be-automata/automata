import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSourceRepo,
  git,
  type SourceRepo,
} from "./__fixtures__/git-fixture";
import {
  checkCapacity,
  ensureMirror,
  fetchDefaultBranch,
  MirrorError,
  purgeOrgMirrors,
  snapshotPaths,
  sweepSnapshotLeftovers,
  verifyMirror,
  withRepoLock,
} from "./mirror";
import { mirrorPaths, type MirrorConfig } from "./mirror-paths";

let root: string;
let src: SourceRepo;
const CONFIG = (): MirrorConfig => ({
  root,
  maxBytes: 2 * 1024 ** 3,
  minFreeBytes: 1,
  snapshotMaxBytes: 256 * 1024 ** 2,
});
const plenty = async () => ({ bavail: 1e12, bsize: 1 });

function setup(org = "org_a", repo = "owner/repo") {
  return mirrorPaths(root, "tenant-1", org, repo);
}

async function mirrorOf(paths = setup()) {
  await ensureMirror({
    paths,
    repoFullName: "owner/repo",
    defaultBranch: "main",
    remoteUrl: src.url,
  });
  await fetchDefaultBranch({
    paths,
    config: CONFIG(),
    defaultBranch: "main",
    token: "ghs_faketoken123456",
    allowFileProtocolForTests: true,
  });
  return paths;
}

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MirrorError);
  expect((err as MirrorError).code).toBe(code);
}

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mirror-root-")),
  );
  src = createSourceRepo();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  src.cleanup();
});

describe("real git allowlist", () => {
  it("fetches twice and still verifies; records the keys plain init writes", async () => {
    src.commit("README.md", "one");
    const paths = await mirrorOf();
    src.commit("README.md", "two");
    await fetchDefaultBranch({
      paths,
      config: CONFIG(),
      defaultBranch: "main",
      token: "ghs_faketoken123456",
      allowFileProtocolForTests: true,
    });
    expect(await verifyMirror(paths.bare, paths.tmpDir)).toEqual({ ok: true });

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "plain-init-"));
    const env = {
      PATH: process.env.PATH,
      HOME: scratch,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    execFileSync("git", ["init", "-q", "--bare", scratch], { env });
    const keys = execFileSync(
      "git",
      ["config", "--file", path.join(scratch, "config"), "--list", "--null"],
      { env, encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean)
      .map((e) => e.split("\n")[0]);
    console.info(
      `MIRROR_GIT_FACTS ${execFileSync("git", ["--version"], { encoding: "utf8" }).trim()} plain-init-bare keys: ${keys.join(",")}`,
    );
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("verifies a config with tabs, comments and quoting", async () => {
    src.commit("a", "1");
    const paths = await mirrorOf();
    fs.writeFileSync(
      path.join(paths.bare, "config"),
      [
        "# comment",
        "[core]",
        "\trepositoryformatversion = 0",
        '  filemode = "true"',
        "\tbare = true ; trailing",
        '[remote   "origin"]',
        `\turl = "${src.url}"`,
        "\tfetch = +refs/heads/main:refs/heads/main",
        "",
      ].join("\n"),
    );
    expect(await verifyMirror(paths.bare, paths.tmpDir)).toEqual({ ok: true });
  });
});

describe("ensureMirror", () => {
  it("creates a bare repo with allowlisted config and no hooks", async () => {
    src.commit("a", "1");
    const paths = setup();
    const res = await ensureMirror({
      paths,
      repoFullName: "owner/repo",
      defaultBranch: "main",
      remoteUrl: src.url,
    });
    expect(res.created).toBe(true);
    expect(fs.statSync(paths.orgDir).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(paths.bare, "hooks"))).toBe(false);
    expect(await verifyMirror(paths.bare, paths.tmpDir)).toEqual({ ok: true });
    const again = await ensureMirror({
      paths,
      repoFullName: "owner/repo",
      defaultBranch: "main",
      remoteUrl: src.url,
    });
    expect(again.created).toBe(false);
  });

  it.each([
    [
      "include.path",
      (b: string) =>
        fs.appendFileSync(
          path.join(b, "config"),
          "[include]\n\tpath = /etc/x\n",
        ),
    ],
    [
      "fsmonitor",
      (b: string) =>
        fs.appendFileSync(
          path.join(b, "config"),
          "[core]\n\tfsmonitor = /bin/true\n",
        ),
    ],
    [
      "promisor",
      (b: string) =>
        fs.appendFileSync(
          path.join(b, "config"),
          '[remote "origin"]\n\tpromisor = true\n',
        ),
    ],
    [
      "partialclone",
      (b: string) =>
        fs.appendFileSync(
          path.join(b, "config"),
          "[extensions]\n\tpartialclone = origin\n",
        ),
    ],
    [
      "alternates",
      (b: string) =>
        fs.writeFileSync(path.join(b, "objects", "info", "alternates"), "/x\n"),
    ],
    ["shallow", (b: string) => fs.writeFileSync(path.join(b, "shallow"), "")],
  ])(
    "tombstones and re-creates a mirror poisoned with %s",
    async (_n, poison) => {
      src.commit("a", "1");
      const paths = await mirrorOf();
      fs.mkdirSync(path.join(paths.bare, "objects", "info"), {
        recursive: true,
      });
      poison(paths.bare);
      expect((await verifyMirror(paths.bare, paths.tmpDir)).ok).toBe(false);
      const res = await ensureMirror({
        paths,
        repoFullName: "owner/repo",
        defaultBranch: "main",
        remoteUrl: src.url,
      });
      expect(res.created).toBe(true);
      expect(await verifyMirror(paths.bare, paths.tmpDir)).toEqual({
        ok: true,
      });
      expect(
        fs.readdirSync(paths.orgDir).filter((n) => n.includes(".tombstone-")),
      ).toEqual([]);
    },
  );

  it("raises mirror_corrupt (no loop) when a fresh write fails verification", async () => {
    // A remote URL carrying credentials fails verification right after the
    // mirror's own fresh write, which must surface instead of looping.
    const paths = setup();
    fs.mkdirSync(paths.orgDir, { recursive: true });
    const result = ensureMirror({
      paths,
      repoFullName: "owner/repo",
      defaultBranch: "main",
      remoteUrl: "https://user:pw@example.invalid/x.git",
    });
    await expectCode(result, "mirror_corrupt");
  });
});

describe("hermetic fetch", () => {
  it("ignores the host git config", async () => {
    src.commit("a", "1");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "evil-home-"));
    const evil = path.join(home, "gitconfig");
    fs.writeFileSync(
      evil,
      "[alias]\n\tfetch = !touch PWNED\n[core]\n\tfsmonitor = touch PWNED\n[color]\n\tui = always\n",
    );
    fs.writeFileSync(path.join(home, ".gitconfig"), fs.readFileSync(evil));
    const prevHome = process.env.HOME;
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.HOME = home;
    process.env.GIT_CONFIG_GLOBAL = evil;
    try {
      await mirrorOf();
    } finally {
      process.env.HOME = prevHome;
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    }
    expect(fs.existsSync(path.join(home, "PWNED"))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("fetches only the default branch, survives a force rewrite, leaks no token", async () => {
    src.commit("a", "1");
    src.branch("other");
    src.commit("a", "2");
    const paths = await mirrorOf();
    const refs = git(paths.bare, "for-each-ref", "--format=%(refname)");
    expect(refs).toBe("refs/heads/main");
    src.rewriteHead("a", "rewritten");
    await fetchDefaultBranch({
      paths,
      config: CONFIG(),
      defaultBranch: "main",
      token: "ghs_faketoken123456",
      allowFileProtocolForTests: true,
    });
    expect(git(paths.bare, "rev-parse", "refs/heads/main")).toBe(src.head());
    const cfg = fs.readFileSync(path.join(paths.bare, "config"), "utf8");
    expect(cfg).not.toMatch(/ghs_|extraheader|credential|Authorization/i);
  });
});

describe("checkCapacity", () => {
  it("disk_low before any fetch, mirror_over_cap on size", async () => {
    src.commit("a", "1");
    const paths = await mirrorOf();
    const cfg = { ...CONFIG(), minFreeBytes: 1000 };
    await expectCode(
      checkCapacity({
        paths,
        config: cfg,
        statfs: async () => ({ bavail: 1, bsize: 10 }),
      }),
      "disk_low",
    );
    await expectCode(
      checkCapacity({
        paths,
        config: { ...CONFIG(), maxBytes: 10 },
        statfs: plenty,
        sizeOf: async () => 11,
      }),
      "mirror_over_cap",
    );
    await expectCode(
      fetchDefaultBranch({
        paths,
        config: cfg,
        defaultBranch: "main",
        token: "t",
        statfs: async () => ({ bavail: 1, bsize: 10 }),
        allowFileProtocolForTests: true,
      }),
      "disk_low",
    );
  });
});

describe("snapshotPaths", () => {
  it("writes blobs under repo/, skips symlinks and missing paths", async () => {
    src.commit("docs/a.md", "alpha");
    src.commit("src/x.ts", "export const x = 1;\n");
    src.commit("bin.dat", "x");
    src.symlink("link", "docs/a.md");
    const target = src.head();
    const paths = await mirrorOf();
    const snap = await snapshotPaths({
      paths,
      config: CONFIG(),
      target,
      relPaths: ["docs/a.md", "src/x.ts", "missing.md", "link"],
      statfs: plenty,
    });
    expect(snap.written.sort()).toEqual(["docs/a.md", "src/x.ts"]);
    expect(
      fs.readFileSync(path.join(snap.root, "repo/docs/a.md"), "utf8"),
    ).toBe("alpha");
    expect(fs.existsSync(path.join(snap.root, "repo/link"))).toBe(false);
    await snap.cleanup();
    expect(fs.existsSync(snap.root)).toBe(false);
  });

  it("round-trips non-utf8 bytes", async () => {
    const bytes = Buffer.from([0, 255, 128, 10, 200, 13]);
    fs.writeFileSync(path.join(src.dir, "b.bin"), bytes);
    git(src.dir, "add", "b.bin");
    git(src.dir, "commit", "-q", "-m", "bin");
    const paths = await mirrorOf();
    const snap = await snapshotPaths({
      paths,
      config: CONFIG(),
      target: src.head(),
      relPaths: ["b.bin"],
      statfs: plenty,
    });
    expect(
      fs.readFileSync(path.join(snap.root, "repo/b.bin")).equals(bytes),
    ).toBe(true);
    await snap.cleanup();
  });

  it("rejects bad paths and targets", async () => {
    src.commit("a", "1");
    const paths = await mirrorOf();
    for (const rel of ["../x", "/abs", ".git/config", "a//b"]) {
      await expectCode(
        snapshotPaths({
          paths,
          config: CONFIG(),
          target: src.head(),
          relPaths: [rel],
          statfs: plenty,
        }),
        "snapshot_failed",
      );
    }
    await expectCode(
      snapshotPaths({
        paths,
        config: CONFIG(),
        target: "main",
        relPaths: ["a"],
        statfs: plenty,
      }),
      "snapshot_failed",
    );
  });

  it("enforces the byte budget and disk recheck before writing", async () => {
    src.commit("a.txt", "x".repeat(1000));
    const paths = await mirrorOf();
    const before = fs.readdirSync(paths.tmpDir);
    await expectCode(
      snapshotPaths({
        paths,
        config: { ...CONFIG(), snapshotMaxBytes: 500 },
        target: src.head(),
        relPaths: ["a.txt"],
        statfs: plenty,
      }),
      "snapshot_failed",
    );
    await expectCode(
      snapshotPaths({
        paths,
        config: { ...CONFIG(), minFreeBytes: 5000 },
        target: src.head(),
        relPaths: ["a.txt"],
        statfs: async () => ({ bavail: 5500, bsize: 1 }),
      }),
      "disk_low",
    );
    expect(fs.readdirSync(paths.tmpDir)).toEqual(before);
  });

  it("removes the partial dir when a write fails", async () => {
    src.commit("a.txt", "1");
    src.commit("b.txt", "2");
    const paths = await mirrorOf();
    const before = fs.readdirSync(paths.tmpDir);
    let n = 0;
    await expectCode(
      snapshotPaths({
        paths,
        config: CONFIG(),
        target: src.head(),
        relPaths: ["a.txt", "b.txt"],
        statfs: plenty,
        writeFile: async (file, data) => {
          if (++n === 2) throw new Error("disk full");
          fs.writeFileSync(file, data);
        },
      }),
      "snapshot_failed",
    );
    expect(fs.readdirSync(paths.tmpDir)).toEqual(before);
  });
});

describe("sweepSnapshotLeftovers", () => {
  it("reaps only old snap-* directories", async () => {
    const tmp = path.join(root, ".tmp-test");
    fs.mkdirSync(path.join(tmp, "snap-old"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "snap-new"));
    fs.mkdirSync(path.join(tmp, "other-old"));
    const old = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(path.join(tmp, "snap-old"), old, old);
    fs.utimesSync(path.join(tmp, "other-old"), old, old);
    await sweepSnapshotLeftovers(tmp, { olderThanMs: 3_600_000 });
    expect(fs.readdirSync(tmp).sort()).toEqual(["other-old", "snap-new"]);
  });
});

describe("withRepoLock", () => {
  it("serializes one repo and does not block another", async () => {
    const a = setup("org_a", "owner/one");
    const b = setup("org_a", "owner/two");
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const first = withRepoLock(a, "first", async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    await new Promise((r) => setTimeout(r, 300));
    const second = withRepoLock(a, "second", async () => {
      order.push("second:start");
    });
    await withRepoLock(b, "other", async () => {
      order.push("other");
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(order).toEqual(["first:start", "other"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "first:start",
      "other",
      "first:end",
      "second:start",
    ]);
  }, 30_000);
});

describe("purgeOrgMirrors", () => {
  it("removes one org, leaves another, and is idempotent", async () => {
    src.commit("a", "1");
    const a = await mirrorOf(setup("org_a"));
    const b = await mirrorOf(setup("org_b"));
    await purgeOrgMirrors({
      root,
      tenantId: "tenant-1",
      organizationId: "org_a",
    });
    expect(fs.existsSync(a.orgDir)).toBe(false);
    expect(fs.existsSync(b.bare)).toBe(true);
    expect(
      fs.readdirSync(a.tenantDir).filter((n) => n.includes(".tombstone-")),
    ).toEqual([]);
    await purgeOrgMirrors({
      root,
      tenantId: "tenant-1",
      organizationId: "org_a",
    });
  });
});
