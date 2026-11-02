import { createHash } from "node:crypto";
import path from "node:path";

import { parseBytesEnv } from "../agent-run/config";

export const DEFAULT_MIRROR_ROOT = "/var/lib/automata/mirrors";

export interface MirrorConfig {
  root: string;
  maxBytes: number;
  minFreeBytes: number;
  snapshotMaxBytes: number;
}

export class MirrorPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MirrorPathError";
  }
}

export function loadMirrorConfig(env: NodeJS.ProcessEnv): MirrorConfig {
  const rawRoot = env.WORKER_MIRROR_ROOT?.trim() ?? "";
  const root = rawRoot === "" ? DEFAULT_MIRROR_ROOT : rawRoot;
  if (!path.isAbsolute(root)) {
    throw new Error(
      `WORKER_MIRROR_ROOT must be an absolute path, got ${JSON.stringify(root)}`,
    );
  }
  return {
    root: path.resolve(root),
    maxBytes: parseBytesEnv(
      "WORKER_MIRROR_MAX_BYTES",
      env.WORKER_MIRROR_MAX_BYTES,
      2 * 1024 ** 3,
    ),
    minFreeBytes: parseBytesEnv(
      "WORKER_MIRROR_MIN_FREE_BYTES",
      env.WORKER_MIRROR_MIN_FREE_BYTES,
      10 * 1024 ** 3,
    ),
    snapshotMaxBytes: parseBytesEnv(
      "WORKER_MIRROR_SNAPSHOT_MAX_BYTES",
      env.WORKER_MIRROR_SNAPSHOT_MAX_BYTES,
      256 * 1024 ** 2,
    ),
  };
}

export interface MirrorPaths {
  tenantDir: string;
  orgDir: string;
  bare: string;
  lockRoot: string;
  tmpDir: string;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

function hash16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Lowercased `owner/name`, or throws. Shared by the paths and the remote URL. */
export function normalizeRepoFullName(repoFullName: string): string {
  const parts = repoFullName.split("/");
  if (parts.length !== 2) {
    throw new MirrorPathError("repository must be owner/name");
  }
  for (const seg of parts) {
    if (
      !SEGMENT.test(seg) ||
      seg.startsWith(".") ||
      seg.toLowerCase() === ".git" ||
      seg.toLowerCase().endsWith(".git")
    ) {
      throw new MirrorPathError("repository segment is not allowed");
    }
  }
  return repoFullName.toLowerCase();
}

function assertInside(root: string, candidate: string): string {
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(root + path.sep)) {
    throw new MirrorPathError("path escapes the mirror root");
  }
  return resolved;
}

/** The tenant and org directories only (purge needs no repo). */
export function orgMirrorDirs(
  root: string,
  tenantId: string,
  organizationId: string,
): { resolvedRoot: string; tenantDir: string; orgDir: string } {
  const resolvedRoot = path.resolve(root);
  if (organizationId === "") {
    throw new MirrorPathError("organization id is required");
  }
  const tenantSeg = /^[A-Za-z0-9-]+$/.test(tenantId) ? tenantId : "default";
  const tenantDir = assertInside(
    resolvedRoot,
    path.join(resolvedRoot, tenantSeg),
  );
  const orgDir = assertInside(
    tenantDir,
    path.join(tenantDir, hash16(organizationId)),
  );
  return { resolvedRoot, tenantDir, orgDir };
}

export function mirrorPaths(
  root: string,
  tenantId: string,
  organizationId: string,
  repoFullName: string,
): MirrorPaths {
  const repo = normalizeRepoFullName(repoFullName);
  const { resolvedRoot, tenantDir, orgDir } = orgMirrorDirs(
    root,
    tenantId,
    organizationId,
  );
  const repoHash = hash16(repo);
  return {
    tenantDir,
    orgDir,
    bare: assertInside(orgDir, path.join(orgDir, `${repoHash}.git`)),
    lockRoot: assertInside(orgDir, path.join(orgDir, `${repoHash}.lock`)),
    tmpDir: assertInside(resolvedRoot, path.join(tenantDir, ".tmp")),
  };
}
