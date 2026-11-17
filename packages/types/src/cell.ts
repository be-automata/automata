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

/**
 * A run's execution timeout (30 min,
 * `packages/worker/src/agent-run/definition.ts:200`) plus a 15 min teardown
 * margin (#656 R6). The cell TTL and its bearer share this one bound (ADR-014).
 */
export const CELL_RUN_TTL_MS = 45 * 60 * 1000;

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

export interface ICellProvider {
  create(plan: CellCreatePlan): Promise<{ cellId: string }>;
  exec(
    cellId: string,
    argv: string[],
    opts?: CellExecOptions,
  ): Promise<CellExecResult>;
  copyOut(cellId: string, path: string): Promise<Uint8Array>;
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
