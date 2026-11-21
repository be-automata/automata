/**
 * Cell contract (#634 S1): the shapes a cell create plan and the cell provider
 * speak. The plan is pre-rendered for its provider (OD-1), so the policy and
 * vault are OpenSandbox-shaped. Types and constants only; the OpenSandbox
 * adapter is S2.
 */

export interface OpenSandboxNetworkRule {
  action: "allow" | "deny";
  /** A domain; absent means every destination. */
  target?: string;
  ports?: number[];
}

export interface OpenSandboxNetworkPolicy {
  defaultAction: "deny";
  egress: OpenSandboxNetworkRule[];
}

/** OpenSandbox `metadata` is a string map, so every value is a string. */
export interface CellTags {
  automata: "cell";
  worker: string;
  epoch: string;
  stepKey: string;
  attempt: string;
  /** Epoch milliseconds as a decimal string. */
  expiresAt: string;
  /** The deployment that owns the cell (its broker host): scopes listing and reaping. */
  deployment: string;
}

/**
 * Header names OpenSandbox accepts for an `apiKey` binding (the upstream
 * `name` pattern, RFC 7230 token characters).
 */
export const CELL_VAULT_HEADER_PATTERN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/** The one www path the cell's daemon calls (#656 Scope 9); the daemon vault binds exactly this. */
export const CELL_DAEMON_EVENT_PATH = "/api/daemon-event";
/** The header the daemon sends its token in. */
export const CELL_DAEMON_TOKEN_HEADER = "X-Daemon-Token";
/** The fixed, non-secret value the guest sends in that header; the sidecar swaps in the real token. */
export const CELL_DAEMON_TOKEN_PLACEHOLDER = "automata-cell-daemon-token";
/**
 * The non-secret token a cell's gh sends (`Authorization: token <x>`, from its
 * `hosts.yml`); the broker binding overwrites the header with the run's bearer
 * at egress (#727 B).
 */
export const CELL_GH_TOKEN_PLACEHOLDER = "automata-cell-gh-placeholder";

interface CellVaultEntryBase {
  name: string;
  hosts: readonly string[];
  paths?: readonly string[];
  /** The raw secret (the provider adds any `Bearer ` prefix). Never log it, never put it in an error. */
  credential: string;
  /**
   * A non-secret literal the guest sends; the proxy replaces it with the
   * credential in the header (upstream `substitutions`, scoped to this binding).
   */
  placeholder?: string;
}

export interface CellVaultBearerEntry extends CellVaultEntryBase {
  auth: "bearer";
}

/** `apiKey` sends the credential in the named request header. */
export interface CellVaultApiKeyEntry extends CellVaultEntryBase {
  auth: "apiKey";
  header: string;
}

/** `basic` needs base64 `user:pass` substitutions this type does not model. */
export type CellVaultEntry = CellVaultBearerEntry | CellVaultApiKeyEntry;

export type CellVaultAuth = CellVaultEntry["auth"];

export interface CellResources {
  cpu: number;
  memoryMiB: number;
}

/**
 * Self-check probe contract: the probe opens TLS and HTTP to a host the policy
 * denies. Exit 3 means it was blocked (egress enforced); exit 0 means it
 * reached the host; any other exit is inconclusive and counts as not enforced.
 */
export const CELL_SELF_CHECK_BLOCKED_EXIT = 3;

/** OpenSandbox's server minimum timeout is 60 s: a shorter cell TTL is refused by the server. */
export const CELL_MIN_TTL_MS = 60_000;

/** The Hatchet `executionTimeout` every lane is registered with (definition.ts pins "30m"). */
export const REGISTERED_EXECUTION_TIMEOUT = 30 * 60 * 1000;
/** The task lane's run budget (#742): the registered 30 min plus a 30 min `refreshTimeout`. */
export const TASK_LANE_EXECUTION_TIMEOUT = 60 * 60 * 1000;
/** The Hatchet `scheduleTimeout` (definition.ts pins "30m"). */
export const SCHEDULE_TIMEOUT = 30 * 60 * 1000;
/** The teardown margin past a run's budget (#656 R6). */
export const CELL_TEARDOWN_MARGIN = 15 * 60 * 1000;

/**
 * The task lane's run budget (60 min, `TASK_LANE_EXECUTION_TIMEOUT`, #742) plus a 15 min teardown margin (#656 R6). Cells
 * run plain task runs only, so one bound serves. The cell TTL and its bearer
 * share it (ADR-014); the OpenSandbox server cap must stay at or above it.
 */
export const CELL_RUN_TTL_MS =
  TASK_LANE_EXECUTION_TIMEOUT + CELL_TEARDOWN_MARGIN;

/** A cell attempt unseen this long is dead (#656 R2): ≥ 30 polls at the worker's 5-10 s cadence. */
export const CELL_LEASE_STALE_MS = 5 * 60 * 1000;

/**
 * OpenSandbox 1.2.1 metadata label value: empty or alphanumeric at both ends with
 * `-_.` inside, at most 63 chars (upstream `validators.py:51-54,88-91`). A create
 * with any other tag value is a 400 whose body quotes the value.
 */
export const CELL_LABEL_VALUE_PATTERN =
  /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;
export const CELL_LABEL_MAX_LENGTH = 63;

/** True for a non-empty value the upstream label rule accepts. */
export function isCellLabelValue(v: string): boolean {
  return (
    v.length > 0 &&
    v.length <= CELL_LABEL_MAX_LENGTH &&
    CELL_LABEL_VALUE_PATTERN.test(v)
  );
}

/**
 * The one derivation of a cell run's `cell_step.step_key` and its `stepKey` tag
 * (byte-equal). It does not validate: callers check `isCellLabelValue` on the
 * result, so the refusal code stays theirs.
 */
export function cellStepKey(apiKeyId: string): string {
  return `cell-${apiKeyId}`;
}

export interface CellKey {
  stepKey: string;
  attempt: number;
}

/** The dead-set key of a cell: `stepKey#attempt`. */
export function cellKeyId(key: CellKey): string {
  return `${key.stepKey}#${key.attempt}`;
}

/** Carries raw secrets in `vault`: sealing it for transport is the caller's job. */
export interface OpenSandboxCellCreatePlan {
  provider: "opensandbox";
  runtime: "runc";
  tags: CellTags;
  networkPolicy: OpenSandboxNetworkPolicy;
  vault: CellVaultEntry[];
  resources: CellResources;
  ttlMs: number;
  egressDigest: string;
  profileId: string;
}

/** One member today; #635 (Gondolin) adds its own variant, discriminated by `provider`. */
export type CellCreatePlan = OpenSandboxCellCreatePlan;

export type CellProviderErrorCode =
  | "wrong_provider"
  | "runtime_not_runc"
  | "policy_required"
  | "ttl_too_short"
  | "invalid_argv"
  | "invalid_plan"
  | "invalid_config"
  | "not_ready"
  | "egress_not_enforced"
  | "origin_refused"
  | "http_error";

/**
 * No `env` and no `stdin`: exec env lands in the guest process environ (procfs),
 * which the vault keeps secrets out of, and spike 058 never measured whether execd
 * logs it (it does log `command`); execd's command API has no stdin. Secrets go
 * only through `CellCreatePlan.vault`.
 */
export interface CellExecOptions {
  cwd?: string;
  timeoutMs?: number;
}

export interface CellExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Structured logger a cell component takes by injection; field values are never secrets. */
export interface CellLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface CellListEntry {
  cellId: string;
  tags: Record<string, string>;
}

export interface CellListOptions {
  /** Stop after this many pages and mark the result truncated. */
  maxPages?: number;
}

/**
 * A `listByTags` result. `truncated` is true when the listing stopped at
 * `maxPages` with more pages available. The adapter sets it non-enumerable, so a
 * copy (spread, `.map`) drops it: read it on the array that was returned.
 */
export type CellList = CellListEntry[] & { readonly truncated?: boolean };

/**
 * `copyIn` options. `mode` is an OCTAL-DIGIT integer (`600`, `644`, `755`),
 * which is how upstream execd's upload reads it (the decimal digits are parsed
 * as octal), so 0600 is `600`, never `384`. `owner` and `group` are sent
 * explicitly, so a file never depends on execd's own process identity.
 */
export interface CellCopyInOptions {
  mode: number;
  owner: string;
  group: string;
}

export interface ICellProvider {
  create(plan: CellCreatePlan): Promise<{ cellId: string }>;
  exec(
    cellId: string,
    argv: string[],
    opts?: CellExecOptions,
  ): Promise<CellExecResult>;
  copyOut(cellId: string, path: string): Promise<Uint8Array>;
  /**
   * Writes `bytes` to the absolute `path` in the cell through upstream execd's
   * `POST /files/upload` (the bytes ride in the request body, so execd's
   * request log never records them). Capped at 16 MiB. The file exists with
   * the default mode between the write and execd's chmod: stage sensitive
   * bytes only inside a 0700 directory.
   */
  copyIn(
    cellId: string,
    path: string,
    bytes: Uint8Array,
    opts: CellCopyInOptions,
  ): Promise<void>;
  /** Provider-side vault clear. */
  revoke(cellId: string): Promise<void>;
  /** Deny-all and drop established connections. */
  quarantine(cellId: string): Promise<void>;
  /** 404 is "gone". */
  delete(cellId: string): Promise<"deleted" | "gone">;
  /**
   * The provider's part after the control plane's revokeAttempt: provider vault
   * clear, then quarantine, then delete. Each step treats 404 as done.
   */
  teardown(cellId: string): Promise<void>;
  listByTags(
    tags: Partial<CellTags>,
    opts?: CellListOptions,
  ): Promise<CellList>;
}

/**
 * The egress switch guard's refusal reasons (#611, OD-1/OD-4), shared by the
 * guard (`@terragon/shared/model/cell-egress-guard`) and the worker, which may
 * show one in a thread (#718). A reason outside this list is never echoed.
 */
export const CELL_EGRESS_GUARD_REASONS = [
  "unknown_profile", // null, undefined, {} or no id
  "egress_mode_missing", // configuration.egress_mode absent
  "egress_mode_observe", // configuration.egress_mode is "observe"
  "egress_mode_unknown", // configuration.egress_mode is any other value than "enforce"
  "egress_not_allowlist", // capabilities.egress !== "allowlist"
  "allowlist_empty", // capabilities.egress_allowlist not a non-empty list of non-blank strings
  "evidence_missing", // no evidence.expires_at
  "evidence_not_from_conformance", // evidence.source !== "conformance"
  "evidence_invalid", // expires_at not RFC 3339
  "evidence_expired", // expires_at <= now
] as const;

export type CellEgressGuardReason = (typeof CELL_EGRESS_GUARD_REASONS)[number];

const CELL_EGRESS_GUARD_REASON_SET: ReadonlySet<string> = new Set(
  CELL_EGRESS_GUARD_REASONS,
);

/** True only for a member of `CELL_EGRESS_GUARD_REASONS`. */
export function isCellEgressReason(x: unknown): x is CellEgressGuardReason {
  return typeof x === "string" && CELL_EGRESS_GUARD_REASON_SET.has(x);
}

/**
 * Every `error` code `POST /api/daemon/cell-plan` can answer (#718). The route
 * types its `refuse()` with it, and the worker's refusal text is keyed by it,
 * so a new code fails to compile until the worker names it.
 */
export const CELL_PLAN_REFUSAL_CODES = [
  "invalid_body",
  "cells_disabled",
  "no_run_key",
  "invalid_run_key",
  "org_required",
  "invalid_deployment_tag",
  "agent_not_supported",
  "thread_terminal",
  "unknown_profile",
  "egress_not_enforced",
  // planCellEgressForRepo's codes
  "egress_level_unsupported",
  "egress_compile_failed",
  "work_branch_unresolved",
  "no_model_credential",
  // openNextAttempt's refusals
  "step_done",
  "conflict",
  "attempt_limit",
  // a newer open for the same requestId: the worker retries it, never shows it
  "superseded",
  // CellPlanError codes
  "runtime_not_runc",
  "bearer_refused",
  "egress_wildcard",
] as const;

export type CellPlanRefusalCode = (typeof CELL_PLAN_REFUSAL_CODES)[number];
