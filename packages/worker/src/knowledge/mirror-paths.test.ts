import path from "node:path";

import { describe, expect, it } from "vitest";

import { hermeticEnv, runMirrorGit, tokenEnv } from "./hermetic-git";
import { loadMirrorConfig, mirrorPaths } from "./mirror-paths";

const ROOT = "/var/lib/automata/mirrors";

describe("mirrorPaths", () => {
  it("is case-insensitive on the repo and distinct per org", () => {
    const a = mirrorPaths(ROOT, "tenant-1", "org_a", "Owner/Repo");
    const b = mirrorPaths(ROOT, "tenant-1", "org_a", "owner/repo");
    const c = mirrorPaths(ROOT, "tenant-1", "org_b", "owner/repo");
    expect(a.bare).toBe(b.bare);
    expect(c.bare).not.toBe(a.bare);
    for (const p of Object.values(a)) {
      expect(p.startsWith(ROOT + path.sep)).toBe(true);
    }
  });

  it.each(["../x/y", "owner/..", ".git/x", "owner/.git", "a/b/c", ""])(
    "rejects repo %j",
    (repo) => {
      expect(() => mirrorPaths(ROOT, "t", "org", repo)).toThrow();
    },
  );

  it("falls back to the default tenant segment for an odd tenant id", () => {
    const p = mirrorPaths(ROOT, "../evil", "org", "o/r");
    expect(p.tenantDir).toBe(path.join(ROOT, "default"));
  });
});

describe("loadMirrorConfig", () => {
  it("defaults", () => {
    expect(loadMirrorConfig({})).toEqual({
      root: ROOT,
      maxBytes: 2 * 1024 ** 3,
      minFreeBytes: 10 * 1024 ** 3,
      snapshotMaxBytes: 256 * 1024 ** 2,
    });
  });
  it("names the knob on a bad value", () => {
    expect(() => loadMirrorConfig({ WORKER_MIRROR_ROOT: "rel/dir" })).toThrow(
      /WORKER_MIRROR_ROOT/,
    );
    for (const k of [
      "WORKER_MIRROR_MAX_BYTES",
      "WORKER_MIRROR_MIN_FREE_BYTES",
      "WORKER_MIRROR_SNAPSHOT_MAX_BYTES",
    ]) {
      expect(() => loadMirrorConfig({ [k]: "lots" })).toThrow(new RegExp(k));
    }
  });
});

describe("hermetic git", () => {
  it("hermeticEnv holds exactly the allowed keys", () => {
    const env = hermeticEnv("/scratch");
    expect(Object.keys(env).sort()).toEqual(
      [
        "GIT_ATTR_NOSYSTEM",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_NO_REPLACE_OBJECTS",
        "GIT_TERMINAL_PROMPT",
        "HOME",
        "LANG",
        "PATH",
      ].sort(),
    );
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.HOME).toBe("/scratch");
  });

  it("tokenEnv scopes the header to github.com", () => {
    const env = tokenEnv("tok");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: basic ${Buffer.from("x-access-token:tok").toString("base64")}`,
    );
  });

  it("a failing call never leaks the token or its base64 form", async () => {
    const token = "ghs_secret1234567890";
    const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
    let caught: unknown;
    try {
      await runMirrorGit("/nonexistent/bare.git", ["fetch", "origin"], {
        env: tokenEnv(token),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    const dump = JSON.stringify([err.message, err.stack, Object.entries(err)]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(b64);
  });
});
