import type { CellPolicyProfile } from "../cell-policy/cell-policy";
import type { mintBearer as mintBearerWithDb } from "./cell-authority";
import type {
  CellCreatePlan,
  CellResources,
  CellTags,
  CellVaultEntry,
} from "@terragon/types/cell";

import {
  CELL_EGRESS_MODEL_HOST,
  compileCellEgress,
  normalizeCellBrokerHost,
  toOpenSandboxNetworkPolicy,
  type CompileCellEgressDeps,
} from "./cell-egress";
import { assertCellEgressEnforced } from "./cell-egress-guard";

export type CellPlanErrorCode = "runtime_not_runc" | "bearer_refused";

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
  tags: Pick<CellTags, "worker" | "epoch">;
  resources: CellResources;
  /** A Claude OAuth token (`bearer`); never logged. */
  modelToken: string;
  runtime: string;
}

const MODEL_PATHS: readonly string[] = ["/v1/*", "/api/*"];
const BROKER_PATHS: readonly string[] = [
  "/api/cell/*",
  "/api/v3/*",
  "/api/graphql",
];

function buildVault(
  input: CellCreatePlanInput,
  brokerHost: string,
  brokerToken: string,
): CellVaultEntry[] {
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
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError("attempt must be a positive integer");
  }
  assertPositiveFinite("resources.cpu", input.resources.cpu);
  assertPositiveFinite("resources.memoryMiB", input.resources.memoryMiB);
  assertNonBlank("stepKey", stepKey);
  assertNonBlank("tags.worker", input.tags.worker);
  assertNonBlank("tags.epoch", input.tags.epoch);
  assertNonBlank("modelToken", input.modelToken);
  if (input.runtime !== "runc") throw new CellPlanError("runtime_not_runc");
  const brokerHost = normalizeCellBrokerHost(input.egress.brokerHost);
  const set = compileCellEgress(input.egressRefs, input.egress);
  const networkPolicy = toOpenSandboxNetworkPolicy(set);
  assertCellEgressEnforced({ profile: input.profile, now: deps.now() });
  const bearer = await deps.mintBearer({ stepKey, attempt, ttlMs });
  if (!bearer.ok) throw new CellPlanError("bearer_refused", bearer.reason);
  return {
    runtime: "runc",
    tags: {
      automata: "cell",
      // Named, not spread: a wider object passed as `tags` must not add metadata keys.
      worker: input.tags.worker,
      epoch: input.tags.epoch,
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
