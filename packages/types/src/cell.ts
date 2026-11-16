/**
 * Cell contract (#634 S1): the provider-neutral shapes a cell create plan and
 * the cell provider speak. Types only; the OpenSandbox adapter is S2.
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

/** No `basic`: it needs base64 `user:pass` and substitutions this type does not model. */
export type CellVaultAuth = "bearer" | "apiKey";

export interface CellVaultEntry {
  name: string;
  hosts: string[];
  paths?: string[];
  auth: CellVaultAuth;
  /** The raw secret (the provider adds any `Bearer ` prefix). Never log it, never put it in an error. */
  credential: string;
}

export interface CellResources {
  cpu: number;
  memoryMiB: number;
}

/** Carries raw secrets in `vault`: sealing it for transport is the caller's job. */
export interface CellCreatePlan {
  runtime: "runc";
  tags: CellTags;
  networkPolicy: OpenSandboxNetworkPolicy;
  vault: CellVaultEntry[];
  resources: CellResources;
  ttlMs: number;
  egressDigest: string;
  profileId: string;
}

export interface CellExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
}

export interface CellExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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
  listByTags(tags: Partial<CellTags>): Promise<CellListEntry[]>;
}
