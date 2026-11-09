import { describe, expect, it } from "vitest";

import { cgroupDirForPid, readMemoryAnon } from "./run-memory";

function files(map: Record<string, string>) {
  return (file: string): string => {
    const v = map[file];
    if (v === undefined) throw new Error(`ENOENT ${file}`);
    return v;
  };
}

const SCOPE =
  "/user.slice/user-995.slice/user@995.service/user.slice/docker-abc.scope";

describe("cgroupDirForPid (#574)", () => {
  // card: protects=the v2 `0::` line of /proc/<pid>/cgroup maps under /sys/fs/cgroup; fails_when=the path is mis-joined or a v1 line is used; no_claim=the real layout (measured on the box)
  it("maps the v2 line under /sys/fs/cgroup", () => {
    expect(
      cgroupDirForPid(7, files({ "/proc/7/cgroup": `0::${SCOPE}\n` })),
    ).toBe(`/sys/fs/cgroup${SCOPE}`);
  });

  // card: protects=a hybrid file still resolves its v2 line; fails_when=a v1 controller line wins; no_claim=nothing
  it("skips v1 controller lines", () => {
    expect(
      cgroupDirForPid(
        7,
        files({
          "/proc/7/cgroup": `12:memory:/docker/abc\n0::${SCOPE}\n`,
        }),
      ),
    ).toBe(`/sys/fs/cgroup${SCOPE}`);
  });

  // card: protects=no usable dir is null, never a throw or a path outside the hierarchy; fails_when=a v1-only host, a gone process, a non-positive pid or a `..` path yields a dir; no_claim=nothing
  it("is null for v1-only, unreadable, bad pid or escaping paths", () => {
    expect(
      cgroupDirForPid(7, files({ "/proc/7/cgroup": "4:memory:/x\n" })),
    ).toBeNull();
    expect(cgroupDirForPid(7, files({}))).toBeNull();
    expect(cgroupDirForPid(0, files({}))).toBeNull();
    expect(cgroupDirForPid(-1, files({}))).toBeNull();
    expect(
      cgroupDirForPid(7, files({ "/proc/7/cgroup": "0::/a/../../etc\n" })),
    ).toBeNull();
    expect(cgroupDirForPid(7, files({ "/proc/7/cgroup": "0::\n" }))).toBeNull();
  });
});

describe("readMemoryAnon (#574)", () => {
  const dir = `/sys/fs/cgroup${SCOPE}`;

  // card: protects=the reading is anon + shmem (what Committed_AS counts), never file cache; fails_when=file pages or memory.current are counted; no_claim=nothing
  it("sums anon and shmem, ignoring file pages", () => {
    expect(
      readMemoryAnon(
        dir,
        files({
          [`${dir}/memory.stat`]: "anon 4096\nfile 999999\nshmem 1024\n",
        }),
      ),
    ).toBe(5120);
  });

  // card: protects=shmem is optional; fails_when=a missing shmem line nulls the reading; no_claim=nothing
  it("treats a missing shmem line as 0", () => {
    expect(
      readMemoryAnon(dir, files({ [`${dir}/memory.stat`]: "anon 4096\n" })),
    ).toBe(4096);
  });

  // card: protects=no anon line or no file is null (the reservation then stays whole); fails_when=either reads as 0, which would release the whole reservation; no_claim=nothing
  it("is null without an anon line or without the file", () => {
    expect(
      readMemoryAnon(dir, files({ [`${dir}/memory.stat`]: "file 10\n" })),
    ).toBeNull();
    expect(readMemoryAnon(dir, files({}))).toBeNull();
  });
});
