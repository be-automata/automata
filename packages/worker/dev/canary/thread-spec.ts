import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { PulledDaemonMessage } from "../../src/agent-run/types";

/**
 * The canary's thread record: what dispatch.mts writes for each run and
 * stub-www.mts serves from. It stands in for the www thread / threadChat rows
 * plus the daemon token row. DEV ONLY (ADR-013 throwaway box): this is not a
 * production code path and nothing in `src/` imports it.
 *
 * One JSON file per thread at `<stateDir>/threads/<threadId>.json`, mode 0600
 * in a 0700 directory: it holds the run's daemon token.
 */

export const CANARY_LANES = ["task", "review", "mention"] as const;
export type CanaryLane = (typeof CANARY_LANES)[number];

export function isCanaryLane(value: unknown): value is CanaryLane {
  return (
    typeof value === "string" &&
    (CANARY_LANES as readonly string[]).includes(value)
  );
}

export interface CanaryThreadSpec {
  version: 1;
  threadId: string;
  threadChatId: string;
  /** SECRET: the run's X-Daemon-Token. Never logged. */
  daemonToken: string;
  lane: CanaryLane;
  repoFullName: string;
  prNumber?: number;
  /** Review lane only: the per-PR key, for the staleness check. */
  prKey?: string;
  /** ISO-8601, the dispatch time (the staleness check orders on it). */
  createdAt: string;
  /** What /api/daemon/next-message serves (www's RemoteDaemonMessage). */
  message: PulledDaemonMessage;
  /**
   * The generation stamp (www's `activeRunExternalId`): written by dispatch
   * after the trigger, review lane only. Absent ⇒ the fence fails open.
   */
  activeRunExternalId?: string;
  /** SECRET: a self-heal check/gate token. The canary never mints one. */
  selfHealToken?: string;
}

/** sha256 hex of a presented secret — the store's lookup key. */
export function secretHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Constant-time compare of two secrets (by their digests, so lengths never leak). */
export function secretsEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/** Refuse a spec file that is not the shape dispatch writes. */
export function parseThreadSpec(raw: unknown): CanaryThreadSpec {
  const s = raw as Partial<CanaryThreadSpec> | null;
  if (
    !s ||
    s.version !== 1 ||
    typeof s.threadId !== "string" ||
    typeof s.threadChatId !== "string" ||
    typeof s.daemonToken !== "string" ||
    s.daemonToken.length < 32 ||
    !isCanaryLane(s.lane) ||
    typeof s.repoFullName !== "string" ||
    typeof s.createdAt !== "string" ||
    typeof s.message !== "object" ||
    s.message === null ||
    s.message.type !== "claude"
  ) {
    throw new Error("canary: malformed thread spec");
  }
  return s as CanaryThreadSpec;
}

export function threadsDir(stateDir: string): string {
  return path.join(stateDir, "threads");
}

function specPath(stateDir: string, threadId: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(threadId)) {
    throw new Error("canary: thread id has an invalid character set");
  }
  return path.join(threadsDir(stateDir), `${threadId}.json`);
}

/** Write (or rewrite) one spec: tmp file at 0600, then rename. */
export function writeThreadSpec(
  stateDir: string,
  spec: CanaryThreadSpec,
): void {
  const dir = threadsDir(stateDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const target = specPath(stateDir, spec.threadId);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(spec, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(tmp, target);
}

export function removeThreadSpec(stateDir: string, threadId: string): void {
  fs.rmSync(specPath(stateDir, threadId), { force: true });
}

/** Every well-formed spec in the directory; a malformed file is skipped (and named). */
export function readThreadSpecs(
  stateDir: string,
  onSkip: (file: string, reason: string) => void = () => {},
): CanaryThreadSpec[] {
  const dir = threadsDir(stateDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: CanaryThreadSpec[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(
        parseThreadSpec(
          JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")),
        ),
      );
    } catch (err) {
      onSkip(name, err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}
