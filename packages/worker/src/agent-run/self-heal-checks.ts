import type { AgentCommandResult, RunAsAgent } from "./agent-command";
import type { SelfHealCheckShape } from "./types";

/**
 * Deterministic, platform-owned check kinds for the self-heal audit (phase 8).
 * Mirrors shared AUDIT_CHECK_KINDS (a drift test pins the two together; the
 * worker does not import from shared at runtime).
 *
 * Injection posture: every script below is a module constant. Agent-derived
 * values (subject, key) reach a command ONLY as positional arguments and are
 * re-validated first. Every read and command runs through the agent uid
 * (the worker uid may not read agent-owned files). An inability to run a check
 * is "error", never "pass".
 */
export const SELF_HEAL_CHECK_KINDS = [
  "npm-audit-clean",
  "workflow-actions-pinned",
  "workflow-has-permissions",
  "file-exists",
  "path-untracked",
  "gitignore-has-pattern",
  "gitleaks-clean",
] as const;

export type SelfHealCheckOutcome = "pass" | "fail" | "error";

export interface SelfHealCheckResult {
  fingerprint: string;
  outcome: SelfHealCheckOutcome;
}

const EXIT_ABSENT = 3;

// Absent file exits 3 so it is distinguishable from an unreadable one.
const READ_SCRIPT = `test -e "$1" || exit ${EXIT_ABSENT}; cat -- "$1"`;
/**
 * POSIX `test` takes no `--`: under dash `test -f -- "$1"` is an operator
 * error (exit 2), which made every probe neither "present" (0) nor "absent"
 * (1) and silently skipped the dependency audit. A leading "-" subject is
 * already rejected by isSafeSubject, so the guard `--` was meant to add is
 * not needed.
 */
export const FILE_EXISTS_SCRIPT = 'test -f "$1"';
const UNTRACKED_SCRIPT = 'git ls-files --error-unmatch -- "$1" >/dev/null 2>&1';
// gitleaks output may contain secrets: it is redirected away, only the exit
// status is observed.
const GITLEAKS_SCRIPT =
  'gitleaks detect --no-git --no-banner --redact --source "$1" --exit-code 1 >/dev/null 2>&1';
// pnpm is the pinned standalone binary the batteries installer provisions at
// a root-owned path that is NOT on the agent's PATH (the box's pnpm is a
// Corepack shim that tries to download the repo's pinned pnpm and fails). The
// path is a positional argument; the script stays a constant. An absent binary
// exits EXIT_ABSENT so it is distinguishable from an audit that failed.
const PNPM_AUDIT_SCRIPT = `test -x "$1" || exit ${EXIT_ABSENT}; exec "$1" audit --prod --json 2>/dev/null`;
const NPM_AUDIT_SCRIPT = "npm audit --omit=dev --json 2>/dev/null";

/**
 * Where install-batteries.sh puts the pinned pnpm (manifest tool "pnpm",
 * kind static-bin). A drift test pins this to the manifest version.
 */
export const AUDIT_PNPM_PATH =
  "/usr/local/lib/automata-batteries/pnpm@10.14.0/bin/pnpm";

/**
 * Keeps pnpm (and a Corepack shim, if one ever runs) from self-switching to
 * the repo's packageManager version, which would need a download.
 */
export const AUDIT_PNPM_ENV: Readonly<Record<string, string>> = {
  npm_config_manage_package_manager_versions: "false",
  COREPACK_ENABLE_STRICT: "0",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
};

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Re-validation of an agent-derived relative path subject. */
export function isSafeSubject(s: string): boolean {
  if (s.length === 0 || s.length > 1024) return false;
  if (s.includes("\u0000") || s.includes("\n") || s.includes("\r")) {
    return false;
  }
  if (s.startsWith("/") || s.startsWith("-") || s.includes("\\")) return false;
  return s.split("/").every((seg) => seg !== ".." && seg !== ".git");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** pnpm audit --json: legacy `advisories` map and/or `vulnerabilities` map. */
export function parsePnpmAuditJson(text: string): Set<string> {
  const doc: unknown = JSON.parse(text);
  if (!isRecord(doc)) throw new Error("pnpm audit output is not an object");
  const names = new Set<string>();
  let recognised = false;
  if (isRecord(doc.advisories)) {
    recognised = true;
    for (const adv of Object.values(doc.advisories)) {
      if (isRecord(adv) && typeof adv.module_name === "string") {
        names.add(adv.module_name);
      }
    }
  }
  if (isRecord(doc.vulnerabilities)) {
    recognised = true;
    for (const name of Object.keys(doc.vulnerabilities)) names.add(name);
  }
  if (!recognised) throw new Error("pnpm audit output has no advisories");
  return names;
}

/** npm audit --json: `vulnerabilities` keyed by package name. */
export function parseNpmAuditJson(text: string): Set<string> {
  const doc: unknown = JSON.parse(text);
  if (!isRecord(doc) || !isRecord(doc.vulnerabilities)) {
    throw new Error("npm audit output has no vulnerabilities");
  }
  return new Set(Object.keys(doc.vulnerabilities));
}

function usesRefs(yaml: string): Array<{ action: string; ref: string | null }> {
  const refs: Array<{ action: string; ref: string | null }> = [];
  for (const line of yaml.split("\n")) {
    const m = /^\s*(?:-\s*)?uses\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    let value = (m[1] ?? "").replace(/\s+#.*$/, "").trim();
    value = value.replace(/^["']|["']$/g, "");
    if (value.startsWith("./") || value.startsWith("docker://")) continue;
    const at = value.indexOf("@");
    refs.push(
      at === -1
        ? { action: value, ref: null }
        : { action: value.slice(0, at), ref: value.slice(at + 1) },
    );
  }
  return refs;
}

/** True when every `uses:` of action `key` (or every external action when no key) is a 40-hex pin. */
export function workflowActionsPinned(yaml: string, key?: string): boolean {
  return usesRefs(yaml)
    .filter(
      (u) =>
        key === undefined || u.action === key || u.action.startsWith(key + "/"),
    )
    .every((u) => u.ref !== null && FULL_SHA.test(u.ref));
}

export function workflowHasPermissions(yaml: string): boolean {
  return /^permissions\s*:/m.test(yaml);
}

export interface RunSelfHealChecksArgs {
  checks: SelfHealCheckShape[];
  run: RunAsAgent;
  /** Sudo target; "" runs as the current user (dev). */
  agentUser: string;
  workdir: string;
  env: NodeJS.ProcessEnv;
  /** Absolute path of the pinned pnpm; defaults to AUDIT_PNPM_PATH. */
  pnpmPath?: string;
  /** Operator-visible reason lines (never agent-derived text). */
  note?: (message: string) => void;
  budgetMs?: number;
  perCheckMs?: number;
  signal?: AbortSignal;
  /** Injectable clock for tests. */
  now?: () => number;
}

type DepAudit = { ok: true; names: Set<string> } | { ok: false };

export async function runSelfHealChecks(
  args: RunSelfHealChecksArgs,
): Promise<SelfHealCheckResult[]> {
  const budgetMs = args.budgetMs ?? 180_000;
  const perCheckMs = args.perCheckMs ?? 60_000;
  const now = args.now ?? Date.now;
  const startedAt = now();

  let depAudit: Promise<DepAudit> | null = null;

  const exec = (
    script: string,
    scriptArgs: string[],
    timeoutMs: number,
    env: NodeJS.ProcessEnv = args.env,
  ): Promise<AgentCommandResult> =>
    args.run({
      agentUser: args.agentUser,
      cwd: args.workdir,
      script,
      args: scriptArgs,
      env,
      timeoutMs,
      signal: args.signal,
    });

  const usable = (r: AgentCommandResult): boolean =>
    !r.timedOut && !r.truncated && r.exitCode !== null;

  const readFile = async (
    path: string,
    timeoutMs: number,
  ): Promise<
    { kind: "absent" } | { kind: "ok"; text: string } | { kind: "error" }
  > => {
    const r = await exec(READ_SCRIPT, [path], timeoutMs);
    if (r.timedOut || r.truncated || r.exitCode === null) {
      return { kind: "error" };
    }
    if (r.exitCode === EXIT_ABSENT) return { kind: "absent" };
    if (r.exitCode !== 0) return { kind: "error" };
    return { kind: "ok", text: r.stdout };
  };

  const loadDepAudit = async (timeoutMs: number): Promise<DepAudit> => {
    const pnpm = await exec(FILE_EXISTS_SCRIPT, ["pnpm-lock.yaml"], timeoutMs);
    if (pnpm.exitCode === 0) {
      const r = await exec(
        PNPM_AUDIT_SCRIPT,
        [args.pnpmPath ?? AUDIT_PNPM_PATH],
        timeoutMs,
        { ...args.env, ...AUDIT_PNPM_ENV },
      );
      if (r.exitCode === EXIT_ABSENT) {
        args.note?.(
          "npm-audit-clean: pinned pnpm is not installed on this box",
        );
        return { ok: false };
      }
      if (!usable(r)) return { ok: false };
      try {
        return { ok: true, names: parsePnpmAuditJson(r.stdout) };
      } catch {
        return { ok: false };
      }
    }
    if (pnpm.exitCode !== 1) return { ok: false };
    const npm = await exec(
      FILE_EXISTS_SCRIPT,
      ["package-lock.json"],
      timeoutMs,
    );
    if (npm.exitCode !== 0) return { ok: false };
    const r = await exec(NPM_AUDIT_SCRIPT, [], timeoutMs);
    if (!usable(r)) return { ok: false };
    try {
      return { ok: true, names: parseNpmAuditJson(r.stdout) };
    } catch {
      return { ok: false };
    }
  };

  const runOne = async (
    check: SelfHealCheckShape,
    timeoutMs: number,
  ): Promise<SelfHealCheckOutcome> => {
    if (!(SELF_HEAL_CHECK_KINDS as readonly string[]).includes(check.check)) {
      return "error";
    }

    if (check.check === "npm-audit-clean") {
      if (!check.subject.startsWith("npm:")) return "error";
      const name = check.subject.slice(4);
      if (!NPM_NAME.test(name)) return "error";
      depAudit ??= loadDepAudit(timeoutMs);
      const audit = await depAudit;
      if (!audit.ok) return "error";
      return audit.names.has(name) ? "fail" : "pass";
    }

    if (!isSafeSubject(check.subject)) return "error";
    const subject = check.subject;

    switch (check.check) {
      case "workflow-actions-pinned":
      case "workflow-has-permissions": {
        const file = await readFile(subject, timeoutMs);
        if (file.kind === "error") return "error";
        if (file.kind === "absent") return "pass";
        if (check.check === "workflow-has-permissions") {
          return workflowHasPermissions(file.text) ? "pass" : "fail";
        }
        return workflowActionsPinned(file.text, check.key) ? "pass" : "fail";
      }
      case "gitignore-has-pattern": {
        if (check.key === undefined || check.key.length === 0) return "error";
        const file = await readFile(subject, timeoutMs);
        if (file.kind !== "ok")
          return file.kind === "absent" ? "fail" : "error";
        const lines = file.text.split("\n").map((l) => l.trim());
        return lines.includes(check.key) ? "pass" : "fail";
      }
      case "file-exists": {
        const r = await exec(FILE_EXISTS_SCRIPT, [subject], timeoutMs);
        if (!usable(r)) return "error";
        return r.exitCode === 0 ? "pass" : r.exitCode === 1 ? "fail" : "error";
      }
      case "path-untracked": {
        const r = await exec(UNTRACKED_SCRIPT, [subject], timeoutMs);
        if (!usable(r)) return "error";
        // 0 = tracked (fail), 1 = pathspec matched nothing (pass); 128 = git broke.
        return r.exitCode === 0 ? "fail" : r.exitCode === 1 ? "pass" : "error";
      }
      case "gitleaks-clean": {
        const r = await exec(GITLEAKS_SCRIPT, [subject], timeoutMs);
        if (!usable(r)) return "error";
        return r.exitCode === 0 ? "pass" : r.exitCode === 1 ? "fail" : "error";
      }
      default:
        return "error";
    }
  };

  const results: SelfHealCheckResult[] = [];
  for (const check of args.checks) {
    const remaining = budgetMs - (now() - startedAt);
    if (remaining <= 0 || args.signal?.aborted) {
      results.push({ fingerprint: check.fingerprint, outcome: "error" });
      continue;
    }
    let outcome: SelfHealCheckOutcome;
    try {
      outcome = await runOne(check, Math.min(perCheckMs, remaining));
    } catch {
      outcome = "error";
    }
    results.push({ fingerprint: check.fingerprint, outcome });
  }
  return results;
}
