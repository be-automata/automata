import { describe, expect, it, vi } from "vitest";

import type { CellPolicyProfile } from "../cell-policy/cell-policy";

import {
  buildCellCreatePlan,
  CellPlanError,
  type CellCreatePlanDeps,
  type CellCreatePlanInput,
} from "./cell-create-plan";
import {
  compileCellEgress,
  toOpenSandboxNetworkPolicy,
  CellEgressError,
} from "./cell-egress";
import { CellEgressNotEnforcedError } from "./cell-egress-guard";
import { BROKER, CATALOG } from "./__fixtures__/cell-egress";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const EXPIRES = new Date("2026-11-15T12:10:00.000Z");
const MODEL_TOKEN = "model-secret-token";
const BROKER_TOKEN = "broker-secret-token";

function profile(patch: Partial<CellPolicyProfile> = {}): CellPolicyProfile {
  return {
    id: "test/profile",
    provider: "test",
    tier: "managed",
    configuration: { egress_mode: "enforce" },
    capabilities: {
      egress: "allowlist",
      egress_allowlist: [BROKER],
    },
    evidence: {
      source: "conformance",
      measured_at: "2026-11-01T00:00:00Z",
      expires_at: "2026-11-15T12:00:00.001Z",
    },
    ...patch,
  };
}

function input(patch: Partial<CellCreatePlanInput> = {}): CellCreatePlanInput {
  return {
    stepKey: "step-1",
    attempt: 2,
    ttlMs: 600_000,
    egressRefs: ["test/npm@1", "test/wild@1"],
    egress: { brokerHost: BROKER, catalog: CATALOG },
    profile: profile(),
    tags: { worker: "w1", epoch: "e1" },
    resources: { cpu: 2, memoryMiB: 2048 },
    modelToken: MODEL_TOKEN,
    runtime: "runc",
    ...patch,
  };
}

function makeDeps(
  mint?: CellCreatePlanDeps["mintBearer"],
): CellCreatePlanDeps & { mintBearer: ReturnType<typeof vi.fn> } {
  return {
    now: () => NOW,
    mintBearer: vi.fn(
      mint ??
        (async () => ({
          ok: true as const,
          token: BROKER_TOKEN,
          expiresAt: EXPIRES,
        })),
    ),
  };
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("buildCellCreatePlan", () => {
  it("S1-a: a refused profile throws and mints nothing", async () => {
    const deps = makeDeps();
    const bad = profile({ configuration: { egress_mode: "observe" } });
    const err = await errorOf(
      buildCellCreatePlan(input({ profile: bad }), deps),
    );
    expect(err).toBeInstanceOf(CellEgressNotEnforcedError);
    expect(deps.mintBearer).not.toHaveBeenCalled();
  });

  it.each(["runsc", "gvisor", ""])(
    "S1-b: runtime %j is refused before compile and mint",
    async (runtime) => {
      const deps = makeDeps();
      // An unresolvable ref would throw CellEgressError if compile ran first.
      const err = await errorOf(
        buildCellCreatePlan(
          input({ runtime, egressRefs: ["test/missing@1"] }),
          deps,
        ),
      );
      expect(err).toBeInstanceOf(CellPlanError);
      expect((err as CellPlanError).code).toBe("runtime_not_runc");
      expect(deps.mintBearer).not.toHaveBeenCalled();
    },
  );

  it("propagates a CellEgressError from compile without minting", async () => {
    const deps = makeDeps();
    const err = await errorOf(
      buildCellCreatePlan(input({ egressRefs: ["test/missing@1"] }), deps),
    );
    expect(err).toBeInstanceOf(CellEgressError);
    expect(deps.mintBearer).not.toHaveBeenCalled();
  });

  it("S1-c: networkPolicy is the rendered policy, default deny, ending in the port-80 deny", async () => {
    const deps = makeDeps();
    const plan = await buildCellCreatePlan(input(), deps);
    const set = compileCellEgress(["test/npm@1", "test/wild@1"], {
      brokerHost: BROKER,
      catalog: CATALOG,
    });
    expect(plan.networkPolicy).toEqual(toOpenSandboxNetworkPolicy(set));
    expect(plan.networkPolicy.defaultAction).toBe("deny");
    expect(plan.networkPolicy.egress.at(-1)).toEqual({
      action: "deny",
      ports: [80],
    });
    expect(plan.egressDigest).toBe(set.digest);
    expect(plan.profileId).toBe("test/profile");
    expect(plan.runtime).toBe("runc");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "S1-g: ttlMs %s throws RangeError before the guard and mint",
    async (ttlMs) => {
      const deps = makeDeps();
      const bad = profile({ configuration: { egress_mode: "observe" } });
      const err = await errorOf(
        buildCellCreatePlan(input({ ttlMs, profile: bad }), deps),
      );
      expect(err).toBeInstanceOf(RangeError);
      expect(deps.mintBearer).not.toHaveBeenCalled();
    },
  );

  it("S1-h: the vault holds the model and broker entries, tags carry the expiry", async () => {
    const deps = makeDeps();
    const plan = await buildCellCreatePlan(input(), deps);
    expect(deps.mintBearer).toHaveBeenCalledWith({
      stepKey: "step-1",
      attempt: 2,
      ttlMs: 600_000,
    });
    expect(plan.vault).toEqual([
      {
        name: "model",
        hosts: ["api.anthropic.com"],
        paths: ["/v1/*", "/api/*"],
        auth: "bearer",
        credential: MODEL_TOKEN,
      },
      {
        name: "broker",
        hosts: [BROKER],
        paths: ["/api/cell/*", "/api/v3/*", "/api/graphql"],
        auth: "bearer",
        credential: BROKER_TOKEN,
      },
    ]);
    expect(plan.tags).toEqual({
      automata: "cell",
      worker: "w1",
      epoch: "e1",
      stepKey: "step-1",
      attempt: "2",
      expiresAt: String(EXPIRES.getTime()),
    });
    expect(plan.ttlMs).toBe(600_000);
    expect(plan.resources).toEqual({ cpu: 2, memoryMiB: 2048 });
  });

  it("S1-f: a bearer refusal throws CellPlanError with the reason and no token", async () => {
    const deps = makeDeps(async () => ({ ok: false, reason: "fenced" }));
    const err = await errorOf(buildCellCreatePlan(input(), deps));
    expect(err).toBeInstanceOf(CellPlanError);
    const e = err as CellPlanError;
    expect(e.code).toBe("bearer_refused");
    expect(e.reason).toBe("fenced");
    expect(e.message).not.toContain(MODEL_TOKEN);
    expect(e.message).not.toContain(BROKER_TOKEN);
  });
});
