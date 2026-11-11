import fs from "node:fs";
import path from "node:path";

/**
 * #574: the anonymous memory a running container's cgroup is charged, read
 * SYNCHRONOUSLY so the #371 headroom decision (headroom.ts `admit`) stays one
 * synchronous step. #498 deleted the host-uid path together with the only
 * caller of `Reservation.observe`, so every live run kept its full run commit
 * reserved for its whole life on top of what `Committed_AS` already counted
 * for it — the third slot could never be admitted.
 *
 * Measured on the execution box (rootless docker, systemd cgroup driver,
 * cgroup v2): `.State.Pid` is a host pid, `/proc/<pid>/cgroup` holds one
 * `0::/user.slice/…/docker-<id>.scope` line, and that scope's `memory.stat`
 * is world-readable, so the worker user reads it without privileges.
 */

/** Sync file read, injectable for tests. Throws when the file cannot be read. */
export type ReadFileSync = (file: string) => string;

const defaultRead: ReadFileSync = (file) => fs.readFileSync(file, "utf8");

/** Where the unified (v2) hierarchy is mounted. */
export const CGROUP_V2_ROOT = "/sys/fs/cgroup";

/**
 * The cgroup v2 directory of `pid`, from its `0::<path>` line in
 * `/proc/<pid>/cgroup`. null when the pid is not positive, the file cannot be
 * read (the process is gone), or there is no v2 line (a v1-only host).
 */
export function cgroupDirForPid(
  pid: number,
  read: ReadFileSync = defaultRead,
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let raw: string;
  try {
    raw = read(`/proc/${pid}/cgroup`);
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (!line.startsWith("0::")) continue;
    const rel = line.slice(3).trim();
    // An empty path or one that escapes the hierarchy is not a usable dir.
    if (!rel.startsWith("/") || rel.split("/").includes("..")) return null;
    return path.join(CGROUP_V2_ROOT, rel);
  }
  return null;
}

/**
 * The anonymous memory the kernel charges a cgroup, in bytes: the `anon` +
 * `shmem` lines of its `memory.stat`. NOT `memory.current`, which also counts
 * file-backed page cache that `Committed_AS` (the commit arm's figure) never
 * includes. Anonymous memory is at or below what the run has committed, so a
 * reservation shrunk by it only ever under-shrinks. null when the file is
 * missing or carries no usable `anon` line.
 */
export function readMemoryAnon(
  cgroupDir: string,
  read: ReadFileSync = defaultRead,
): number | null {
  let raw: string;
  try {
    raw = read(path.join(cgroupDir, "memory.stat"));
  } catch {
    return null;
  }
  let anon: number | null = null;
  let shmem = 0;
  for (const line of raw.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) continue;
    if (key === "anon") anon = n;
    else if (key === "shmem") shmem = n;
  }
  return anon === null ? null : anon + shmem;
}
