import type { CellPolicyProfile } from "../cell-policy/cell-policy";
import type { mintBearer as mintBearerWithDb } from "./cell-authority";
import type {
  CellCreatePlan,
  CellResources,
  CellTags,
  CellVaultEntry,
} from "@terragon/types/cell";

import {
  CELL_DAEMON_EVENT_PATH,
  CELL_DAEMON_TOKEN_HEADER,
  CELL_DAEMON_TOKEN_PLACEHOLDER,
  CELL_MIN_TTL_MS,
  CELL_RUN_TTL_MS,
} from "@terragon/types/cell";

import {
  CELL_EGRESS_MODEL_HOST,
  compileCellEgress,
  normalizeCellBrokerHost,
  toOpenSandboxNetworkPolicy,
  type CompileCellEgressDeps,
} from "./cell-egress";
import { assertCellEgressEnforced } from "./cell-egress-guard";

export type CellPlanErrorCode =
  | "runtime_not_runc"
  | "bearer_refused"
  | "egress_wildcard";

// The daemon binding's path, header and placeholder live in @terragon/types so
// the sandbox live gate binds the same values (sandbox cannot import shared).
export { CELL_DAEMON_EVENT_PATH, CELL_DAEMON_TOKEN_PLACEHOLDER };

/**
 * A refused plan. The message is the fixed code only: `reason` comes from the
 * injected `mintBearer` and is never interpolated, so a caller that puts a
 * token in it cannot leak it through the message.
 */
export class CellPlanError extends Error {
  readonly code: CellPlanErrorCode;
  readonly reason?: MintBearerRefusal;

  constructor(code: CellPlanErrorCode, reason?: MintBearerRefusal) {
    super(code);
    this.name = "CellPlanError";
    this.code = code;
    this.reason = reason;
  }
}

/** `mintBearer` with `db` bound by the caller; type-only, so the builder never loads the DB module. */
export type MintBearerArgs = Omit<Parameters<typeof mintBearerWithDb>[0], "db">;
export type MintBearerResult = Awaited<ReturnType<typeof mintBearerWithDb>>;
export type MintBearerRefusal = Extract<
  MintBearerResult,
  { ok: false }
>["reason"];

export interface CellCreatePlanDeps {
  now: () => Date;
  mintBearer: (args: MintBearerArgs) => Promise<MintBearerResult>;
}

export interface CellCreatePlanInput {
  stepKey: string;
  attempt: number;
  ttlMs: number;
  egressRefs: readonly string[];
  egress: CompileCellEgressDeps;
  profile: CellPolicyProfile;
  tags: Pick<CellTags, "worker" | "epoch" | "deployment">;
  resources: CellResources;
  /** A Claude OAuth token (`bearer`); never logged. */
  modelToken: string;
  /**
   * The cell's `X-Daemon-Token` value; never logged. When present, the vault
   * gets a daemon entry for exactly `CELL_DAEMON_EVENT_PATH`. www passes the
   * cell's own event-only token here, never the worker's run token (#693).
   */
  daemonToken?: string;
  runtime: string;
}

const MODEL_PATHS: readonly string[] = ["/v1/*", "/api/*"];
const BROKER_PATHS: readonly string[] = [
  "/api/cell/*",
  "/api/v3/*",
  "/api/graphql",
];

/**
 * The vault entry that lets the daemon call `POST /api/daemon-event` and nothing
 * else. The path is fixed on purpose (#656 Scope 9). It is no longer the only
 * barrier: the token is event-scoped, and www refuses it on every other route
 * (#693).
 */
export function buildDaemonVaultEntry(
  brokerHost: string,
  daemonToken: string,
): CellVaultEntry {
  return {
    name: "daemon",
    hosts: [brokerHost],
    paths: [CELL_DAEMON_EVENT_PATH],
    auth: "apiKey",
    header: CELL_DAEMON_TOKEN_HEADER,
    credential: daemonToken,
    placeholder: CELL_DAEMON_TOKEN_PLACEHOLDER,
  };
}

function buildVault(
  input: CellCreatePlanInput,
  brokerHost: string,
  brokerToken: string,
): CellVaultEntry[] {
  const daemon =
    input.daemonToken === undefined
      ? []
      : [buildDaemonVaultEntry(brokerHost, input.daemonToken)];
  return [
    {
      name: "model",
      hosts: [CELL_EGRESS_MODEL_HOST],
      paths: MODEL_PATHS,
      auth: "bearer",
      credential: input.modelToken,
    },
    {
      name: "broker",
      hosts: [brokerHost],
      paths: BROKER_PATHS,
      auth: "bearer",
      credential: brokerToken,
    },
    ...daemon,
  ];
}

/** The message names the field only: `value` may be a secret (the model token). */
function assertNonBlank(field: string, value: string): void {
  if (value.trim() === "") throw new RangeError(`${field} must not be blank`);
}

function assertPositiveFinite(field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive finite number`);
  }
}

/**
 * The one create plan a cell runs on (#634). Each step runs only after the
 * previous one succeeded, so a refused profile mints no bearer.
 */
export async function buildCellCreatePlan(
  input: CellCreatePlanInput,
  deps: CellCreatePlanDeps,
): Promise<CellCreatePlan> {
  const { stepKey, attempt, ttlMs } = input;
  assertPositiveFinite("ttlMs", ttlMs);
  if (ttlMs < CELL_MIN_TTL_MS) {
    throw new RangeError(`ttlMs must be at least ${CELL_MIN_TTL_MS}`);
  }
  if (ttlMs > CELL_RUN_TTL_MS) {
    throw new RangeError(`ttlMs must be at most ${CELL_RUN_TTL_MS}`);
  }
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError("attempt must be a positive integer");
  }
  assertPositiveFinite("resources.cpu", input.resources.cpu);
  assertPositiveFinite("resources.memoryMiB", input.resources.memoryMiB);
  assertNonBlank("stepKey", stepKey);
  assertNonBlank("tags.worker", input.tags.worker);
  assertNonBlank("tags.epoch", input.tags.epoch);
  assertNonBlank("tags.deployment", input.tags.deployment);
  assertNonBlank("modelToken", input.modelToken);
  if (input.daemonToken !== undefined) {
    assertNonBlank("daemonToken", input.daemonToken);
    if (input.daemonToken !== input.daemonToken.trim()) {
      throw new RangeError("daemonToken must not have surrounding whitespace");
    }
  }
  if (input.runtime !== "runc") throw new CellPlanError("runtime_not_runc");
  const brokerHost = normalizeCellBrokerHost(input.egress.brokerHost);
  const set = compileCellEgress(input.egressRefs, input.egress);
  if (set.entries.some((e) => e.wildcard)) {
    throw new CellPlanError("egress_wildcard");
  }
  const networkPolicy = toOpenSandboxNetworkPolicy(set);
  assertCellEgressEnforced({ profile: input.profile, now: deps.now() });
  const bearer = await deps.mintBearer({ stepKey, attempt, ttlMs });
  if (!bearer.ok) throw new CellPlanError("bearer_refused", bearer.reason);
  return {
    provider: "opensandbox",
    runtime: "runc",
    tags: {
      automata: "cell",
      // Named, not spread: a wider object passed as `tags` must not add metadata keys.
      worker: input.tags.worker,
      epoch: input.tags.epoch,
      deployment: input.tags.deployment,
      stepKey,
      attempt: String(attempt),
      expiresAt: String(bearer.expiresAt.getTime()),
    },
    networkPolicy,
    vault: buildVault(input, brokerHost, bearer.token),
    resources: input.resources,
    ttlMs,
    egressDigest: set.digest,
    profileId: input.profile.id,
  };
}
