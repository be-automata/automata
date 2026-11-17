import { describe, expect, it, vi } from "vitest";

import { createOpenSandboxCellProvider } from "@terragon/sandbox/opensandbox-cell";

import type { CellPolicyProfile } from "../cell-policy/cell-policy";

import { BROKER, CATALOG } from "./__fixtures__/cell-egress";
import {
  buildCellCreatePlan,
  type CellCreatePlanDeps,
  type CellCreatePlanInput,
} from "./cell-create-plan";
import { compileCellEgress, toOpenSandboxNetworkPolicy } from "./cell-egress";
import { CellEgressNotEnforcedError } from "./cell-egress-guard";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const EXPIRES = new Date("2026-11-15T12:10:00.000Z");
const EGRESS_REFS = ["test/npm@1", "test/pypi@1"];

function profile(patch: Partial<CellPolicyProfile> = {}): CellPolicyProfile {
  return {
    id: "test/profile",
    provider: "test",
    tier: "managed",
    configuration: { egress_mode: "enforce" },
    capabilities: { egress: "allowlist", egress_allowlist: [BROKER] },
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
    attempt: 1,
    ttlMs: 600_000,
    egressRefs: EGRESS_REFS,
    egress: { brokerHost: BROKER, catalog: CATALOG },
    profile: profile(),
    tags: { worker: "w1", epoch: "e1", deployment: BROKER },
    resources: { cpu: 2, memoryMiB: 2048 },
    modelToken: "model-token",
    runtime: "runc",
    ...patch,
  };
}

const planDeps: CellCreatePlanDeps = {
  now: () => NOW,
  mintBearer: async () => ({
    ok: true as const,
    token: "broker-token",
    expiresAt: EXPIRES,
  }),
};

function fetchSpy() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const spy = vi.fn(
    async (reqInput: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(reqInput));
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (method === "POST" && url.pathname === "/sandboxes") {
        return new Response(JSON.stringify({ id: "c1" }), { status: 202 });
      }
      if (url.pathname.endsWith("/ping")) return new Response("{}");
      if (url.pathname.endsWith("/command")) {
        const done = { type: "execution_complete", exit_code: 3 };
        return new Response(`data: ${JSON.stringify(done)}\n\n`);
      }
      return new Response("{}", { status: 201 });
    },
  );
  return { spy, calls };
}

function provider(spy: ReturnType<typeof fetchSpy>["spy"]) {
  return createOpenSandboxCellProvider(
    {
      baseUrl: "http://os.test",
      apiKey: "api-key",
      image: "registry.test/cell@sha256:abc",
      entrypoint: ["/bin/sleep", "infinity"],
      selfCheck: { argv: ["/probe"] },
    },
    {
      fetch: spy as unknown as typeof fetch,
      sleep: async () => {},
      now: () => 0,
      logger: { info: () => {}, warn: () => {} },
    },
  );
}

describe("AC-1: plan to provider, end to end", () => {
  it("(a) a refused profile throws and the fetch spy records zero calls", async () => {
    const { spy } = fetchSpy();
    const bad = profile({ configuration: { egress_mode: "observe" } });
    const cells = provider(spy);
    await expect(
      (async () => {
        const plan = await buildCellCreatePlan(
          input({ profile: bad }),
          planDeps,
        );
        return cells.create(plan);
      })(),
    ).rejects.toBeInstanceOf(CellEgressNotEnforcedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("(b) the POST /sandboxes networkPolicy deep-equals the rendered policy", async () => {
    const { spy, calls } = fetchSpy();
    const plan = await buildCellCreatePlan(input(), planDeps);
    await expect(provider(spy).create(plan)).resolves.toEqual({ cellId: "c1" });
    const post = calls.find(
      (c) => c.method === "POST" && c.path === "/sandboxes",
    );
    const rendered = toOpenSandboxNetworkPolicy(
      compileCellEgress(EGRESS_REFS, { brokerHost: BROKER, catalog: CATALOG }),
    );
    expect((post?.body as { networkPolicy: unknown }).networkPolicy).toEqual(
      rendered,
    );
  });
});
