/**
 * Cell contract (#634 S1): the shapes a cell create plan and the cell provider
 * speak. The plan is pre-rendered for its provider (OD-1), so the policy and
 * vault are OpenSandbox-shaped. Types only; the OpenSandbox adapter is S2.
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
}

/**
 * Bearer only: OpenSandbox `apiKey` needs a header name this type does not carry,
 * and `basic` needs base64 `user:pass` substitutions it does not model.
 */
export type CellVaultAuth = "bearer";

export interface CellVaultEntry {
  name: string;
  hosts: readonly string[];
  paths?: readonly string[];
  auth: CellVaultAuth;
  /** The raw secret (the provider adds any `Bearer ` prefix). Never log it, never put it in an error. */
  credential: string;
}

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
  listByTags(tags: Partial<CellTags>): Promise<CellListEntry[]>;
}
