import type { CellPolicyProfile } from "../cell-policy/cell-policy";
import type {
  CellCreatePlan,
  CellResources,
  CellTags,
  CellVaultEntry,
} from "@terragon/types/cell";

import {
  CELL_EGRESS_MODEL_HOST,
  compileCellEgress,
  toOpenSandboxNetworkPolicy,
  type CompileCellEgressDeps,
} from "./cell-egress";
import { assertCellEgressEnforced } from "./cell-egress-guard";

export type CellPlanErrorCode = "runtime_not_runc" | "bearer_refused";

/** A refused plan. The message never contains a token. */
export class CellPlanError extends Error {
  readonly code: CellPlanErrorCode;
  readonly reason?: string;

  constructor(code: CellPlanErrorCode, reason?: string) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = "CellPlanError";
    this.code = code;
    this.reason = reason;
  }
}

export interface MintBearerArgs {
  stepKey: string;
  attempt: number;
  ttlMs: number;
}

export type MintBearerResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: string };

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

const MODEL_PATHS = ["/v1/*", "/api/*"];
const BROKER_PATHS = ["/api/cell/*", "/api/v3/*", "/api/graphql"];

function buildVault(
  input: CellCreatePlanInput,
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
      hosts: [input.egress.brokerHost],
      paths: BROKER_PATHS,
      auth: "bearer",
      credential: brokerToken,
    },
  ];
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
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("ttlMs must be a positive finite number");
  }
  if (input.runtime !== "runc") throw new CellPlanError("runtime_not_runc");
  const set = compileCellEgress(input.egressRefs, input.egress);
  const networkPolicy = toOpenSandboxNetworkPolicy(set);
  assertCellEgressEnforced({ profile: input.profile, now: deps.now() });
  const bearer = await deps.mintBearer({ stepKey, attempt, ttlMs });
  if (!bearer.ok) throw new CellPlanError("bearer_refused", bearer.reason);
  return {
    runtime: "runc",
    tags: {
      automata: "cell",
      ...input.tags,
      stepKey,
      attempt: String(attempt),
      expiresAt: String(bearer.expiresAt.getTime()),
    },
    networkPolicy,
    vault: buildVault(input, bearer.token),
    resources: input.resources,
    ttlMs,
    egressDigest: set.digest,
    profileId: input.profile.id,
  };
}
