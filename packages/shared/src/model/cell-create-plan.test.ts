import { describe, expect, it, vi } from "vitest";

import { CELL_MIN_TTL_MS, CELL_RUN_TTL_MS } from "@terragon/types/cell";

import type { CellPolicyProfile } from "../cell-policy/cell-policy";

import {
  buildCellCreatePlan,
  CELL_DAEMON_TOKEN_PLACEHOLDER,
  CellPlanError,
  type CellCreatePlanDeps,
  type CellCreatePlanInput,
  type MintBearerRefusal,
} from "./cell-create-plan";
import {
  CELL_EGRESS_MODEL_HOST,
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
    egressRefs: ["test/npm@1", "test/pypi@1"],
    egress: { brokerHost: BROKER, catalog: CATALOG },
    profile: profile(),
    tags: { worker: "w1", epoch: "e1", deployment: BROKER },
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

describe("buildCellCreatePlan", () => {
  it("S1-a: a refused profile throws and mints nothing", async () => {
    const deps = makeDeps();
    const bad = profile({ configuration: { egress_mode: "observe" } });
    await expect(
      buildCellCreatePlan(input({ profile: bad }), deps),
    ).rejects.toBeInstanceOf(CellEgressNotEnforcedError);
    expect(deps.mintBearer).not.toHaveBeenCalled();
  });

  it.each(["runsc", "gvisor", ""])(
    "S1-b: runtime %j is refused before compile and mint",
    async (runtime) => {
      const deps = makeDeps();
      // An unresolvable ref would throw CellEgressError if compile ran first.
      const p = buildCellCreatePlan(
        input({ runtime, egressRefs: ["test/missing@1"] }),
        deps,
      );
      await expect(p).rejects.toBeInstanceOf(CellPlanError);
      await expect(p).rejects.toMatchObject({ code: "runtime_not_runc" });
      expect(deps.mintBearer).not.toHaveBeenCalled();
    },
  );

  it("propagates a CellEgressError from compile without minting", async () => {
    const deps = makeDeps();
    await expect(
      buildCellCreatePlan(input({ egressRefs: ["test/missing@1"] }), deps),
    ).rejects.toBeInstanceOf(CellEgressError);
    expect(deps.mintBearer).not.toHaveBeenCalled();
  });

  it("S1-c: networkPolicy is exactly the rendered policy", async () => {
    const deps = makeDeps();
    const plan = await buildCellCreatePlan(input(), deps);
    const set = compileCellEgress(["test/npm@1", "test/pypi@1"], {
      brokerHost: BROKER,
      catalog: CATALOG,
    });
    expect(plan.networkPolicy).toEqual(toOpenSandboxNetworkPolicy(set));
    expect(plan.egressDigest).toBe(set.digest);
    expect(plan.profileId).toBe("test/profile");
    expect(plan.runtime).toBe("runc");
    expect(plan.provider).toBe("opensandbox");
  });

  it("accepts a ttl of exactly CELL_MIN_TTL_MS", async () => {
    const plan = await buildCellCreatePlan(
      input({ ttlMs: CELL_MIN_TTL_MS }),
      makeDeps(),
    );
    expect(plan.ttlMs).toBe(CELL_MIN_TTL_MS);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, CELL_MIN_TTL_MS - 1])(
    "S1-g: ttlMs %s throws RangeError before the guard and mint",
    async (ttlMs) => {
      const deps = makeDeps();
      const bad = profile({ configuration: { egress_mode: "observe" } });
      await expect(
        buildCellCreatePlan(input({ ttlMs, profile: bad }), deps),
      ).rejects.toBeInstanceOf(RangeError);
      expect(deps.mintBearer).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["attempt", { attempt: 0 }],
    ["attempt", { attempt: 1.5 }],
    ["attempt", { attempt: Number.NaN }],
    ["resources.cpu", { resources: { cpu: 0, memoryMiB: 2048 } }],
    ["resources.memoryMiB", { resources: { cpu: 2, memoryMiB: -1 } }],
    ["resources.cpu", { resources: { cpu: Number.NaN, memoryMiB: 2048 } }],
    ["stepKey", { stepKey: "" }],
    ["tags.worker", { tags: { worker: " ", epoch: "e1", deployment: BROKER } }],
    ["tags.epoch", { tags: { worker: "w1", epoch: "", deployment: BROKER } }],
    [
      "tags.deployment",
      { tags: { worker: "w1", epoch: "e1", deployment: " " } },
    ],
    ["modelToken", { modelToken: "\t" }],
    ["daemonToken", { daemonToken: " " }],
    ["daemonToken", { daemonToken: "" }],
    ["daemonToken", { daemonToken: " tok-with-spaces " }],
  ] as const)(
    "%s out of range throws RangeError before the guard and mint",
    async (_field, patch) => {
      const deps = makeDeps();
      const bad = profile({ configuration: { egress_mode: "observe" } });
      await expect(
        buildCellCreatePlan(input({ ...patch, profile: bad }), deps),
      ).rejects.toBeInstanceOf(RangeError);
      expect(deps.mintBearer).not.toHaveBeenCalled();
    },
  );

  it.each([` ${BROKER.toUpperCase()}. `, `${BROKER}:443`])(
    "the broker vault host matches the policy target for %j",
    async (brokerHost) => {
      const plan = await buildCellCreatePlan(
        input({ egress: { brokerHost, catalog: CATALOG } }),
        makeDeps(),
      );
      const broker = plan.vault.find((v) => v.name === "broker");
      expect(broker?.hosts).toEqual([BROKER]);
      expect(plan.networkPolicy.egress).toContainEqual({
        action: "allow",
        target: BROKER,
      });
    },
  );

  it("a wildcard broker host is refused before mint", async () => {
    const deps = makeDeps();
    await expect(
      buildCellCreatePlan(
        input({ egress: { brokerHost: `*.${BROKER}`, catalog: CATALOG } }),
        deps,
      ),
    ).rejects.toMatchObject({ code: "invalid_host" });
    expect(deps.mintBearer).not.toHaveBeenCalled();
  });

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
        hosts: [CELL_EGRESS_MODEL_HOST],
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
      deployment: BROKER,
      stepKey: "step-1",
      attempt: "2",
      expiresAt: String(EXPIRES.getTime()),
    });
    expect(plan.ttlMs).toBe(600_000);
    expect(plan.resources).toEqual({ cpu: 2, memoryMiB: 2048 });
  });

  describe("daemon entry, run TTL and wildcards (#656 PR-B)", () => {
    const DAEMON_TOKEN = "daemon-secret-token";

    it("adds the daemon entry with its exact shape and exact path", async () => {
      const plan = await buildCellCreatePlan(
        input({ daemonToken: DAEMON_TOKEN }),
        makeDeps(),
      );
      expect(plan.vault.map((v) => v.name)).toEqual([
        "model",
        "broker",
        "daemon",
      ]);
      expect(plan.vault[2]).toEqual({
        name: "daemon",
        hosts: [BROKER],
        paths: ["/api/daemon-event"],
        auth: "apiKey",
        header: "X-Daemon-Token",
        credential: DAEMON_TOKEN,
        placeholder: CELL_DAEMON_TOKEN_PLACEHOLDER,
      });
      expect(CELL_DAEMON_TOKEN_PLACEHOLDER).not.toContain(DAEMON_TOKEN);
      expect(plan.vault[2]?.paths?.some((p) => p.includes("*"))).toBe(false);
    });

    it("has no daemon entry without a daemonToken", async () => {
      const plan = await buildCellCreatePlan(input(), makeDeps());
      expect(plan.vault.map((v) => v.name)).toEqual(["model", "broker"]);
    });

    it("refuses a wildcard egress set before mintBearer", async () => {
      const deps = makeDeps();
      const p = buildCellCreatePlan(
        input({ egressRefs: ["test/npm@1", "test/wild@1"] }),
        deps,
      );
      await expect(p).rejects.toBeInstanceOf(CellPlanError);
      await expect(p).rejects.toMatchObject({
        code: "egress_wildcard",
        message: "egress_wildcard",
      });
      expect(deps.mintBearer).not.toHaveBeenCalled();
    });

    it("accepts a ttl of exactly CELL_RUN_TTL_MS and refuses one over it before mint", async () => {
      const ok = await buildCellCreatePlan(
        input({ ttlMs: CELL_RUN_TTL_MS }),
        makeDeps(),
      );
      expect(ok.ttlMs).toBe(CELL_RUN_TTL_MS);
      const deps = makeDeps();
      await expect(
        buildCellCreatePlan(input({ ttlMs: CELL_RUN_TTL_MS + 1 }), deps),
      ).rejects.toBeInstanceOf(RangeError);
      expect(deps.mintBearer).not.toHaveBeenCalled();
    });

    it("a blank daemonToken is refused before mint without echoing it", async () => {
      const deps = makeDeps();
      const p = buildCellCreatePlan(input({ daemonToken: "  " }), deps);
      await expect(p).rejects.toThrow("daemonToken must not be blank");
      expect(deps.mintBearer).not.toHaveBeenCalled();
    });
  });

  it("S1-f: a bearer refusal keeps its reason but never puts it in the message", async () => {
    // The injected mint is untrusted: prove a token-bearing reason cannot leak.
    const leaky =
      `upstream said ${BROKER_TOKEN} / ${MODEL_TOKEN}` as MintBearerRefusal;
    const deps = makeDeps(async () => ({ ok: false, reason: leaky }));
    const p = buildCellCreatePlan(input(), deps);
    await expect(p).rejects.toBeInstanceOf(CellPlanError);
    await expect(p).rejects.toMatchObject({
      code: "bearer_refused",
      reason: leaky,
      message: "bearer_refused",
    });
    await expect(p).rejects.not.toThrow(BROKER_TOKEN);
    await expect(p).rejects.not.toThrow(MODEL_TOKEN);
  });

  it("tags carry only the named keys, even from a wider tags object", async () => {
    const wide = {
      worker: "w1",
      epoch: "e1",
      deployment: BROKER,
      automata: "other",
      extra: "x",
    };
    const plan = await buildCellCreatePlan(input({ tags: wide }), makeDeps());
    expect(Object.keys(plan.tags).sort()).toEqual([
      "attempt",
      "automata",
      "deployment",
      "epoch",
      "expiresAt",
      "stepKey",
      "worker",
    ]);
    expect(plan.tags.automata).toBe("cell");
  });

  it("the rendered policy does not depend on the order of egressRefs", async () => {
    const a = await buildCellCreatePlan(input(), makeDeps());
    const b = await buildCellCreatePlan(
      input({ egressRefs: ["test/pypi@1", "test/npm@1"] }),
      makeDeps(),
    );
    expect(b.networkPolicy).toEqual(a.networkPolicy);
    expect(b.egressDigest).toBe(a.egressDigest);
  });
});
