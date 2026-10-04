import { describe, expect, it, vi } from "vitest";

import type { DB } from "@terragon/shared/db";
import type { BreakerRow } from "@terragon/shared/model/self-heal-breaker";

import {
  preflightCapabilities,
  SELF_HEAL_CAPABILITIES,
  type PreflightBreakerOps,
  type PreflightDeps,
} from "./self-heal-preflight";

const ORG = "org-1";
const KEY = "4242";
const NOW = new Date("2026-10-04T12:00:00Z");

function row(
  permission: string,
  state: "closed" | "open",
  updatedAt: Date,
): BreakerRow {
  return {
    id: "x",
    organizationId: ORG,
    scopeKind: "permission",
    scopeKey: `${KEY}:${permission}`,
    state,
    openedAt: null,
    openUntil: null,
    halfOpenProbesLeft: 0,
    probeInFlightUntil: null,
    tripCount: 0,
    lastTripReason: null,
    lastTripEvidence: null,
    rateLimitedUntil: null,
    version: 1,
    updatedAt,
  };
}

function fixture(rows: Record<string, BreakerRow> = {}) {
  const breaker = {
    getBreakerState: vi.fn(
      async (a: { scopeKind: string; scopeKey: string }) =>
        rows[a.scopeKey] ?? {
          ...row("none", "closed", new Date(0)),
          scopeKind: a.scopeKind,
          scopeKey: a.scopeKey,
          version: -1,
        },
    ),
    recordBreakerEvent: vi.fn(async () => undefined),
    evaluateApiBreaker: vi.fn(async () => null),
    extendRateLimitedUntil: vi.fn(async () => undefined),
    setPermissionLatch: vi.fn(async () => undefined),
    clearPermissionLatch: vi.fn(async () => undefined),
    acquireHalfOpenProbe: vi.fn(async () => true),
  };
  const getPermissions = vi.fn();
  const deps: PreflightDeps = {
    db: {} as DB,
    now: () => NOW,
    log: () => undefined,
    sleep: async () => undefined,
    rand: () => 0.5,
    breaker: breaker as unknown as PreflightBreakerOps,
    getPermissions,
  };
  return { breaker, getPermissions, deps };
}

const DEADLINE = new Date(NOW.getTime() + 60_000);

function run(
  f: ReturnType<typeof fixture>,
  capability: "writer" | "fixLoop" = "writer",
) {
  return preflightCapabilities({
    organizationId: ORG,
    installationKey: KEY,
    owner: "o",
    repo: "r",
    capability,
    deadlineAt: DEADLINE,
    deps: f.deps,
  });
}

describe("preflightCapabilities", () => {
  it("issues write is ok and clears the latch", async () => {
    const f = fixture();
    f.getPermissions.mockResolvedValue({
      installationId: 4242,
      permissions: { issues: "write" },
    });
    expect(await run(f)).toEqual({ ok: true, installationId: 4242 });
    expect(f.breaker.clearPermissionLatch).toHaveBeenCalledWith(
      expect.objectContaining({ permission: "issues", installationId: KEY }),
    );
    expect(f.breaker.setPermissionLatch).not.toHaveBeenCalled();
  });

  it("issues read is missing and latches", async () => {
    const f = fixture();
    f.getPermissions.mockResolvedValue({
      installationId: 4242,
      permissions: { issues: "read" },
    });
    expect(await run(f)).toEqual({
      ok: false,
      missing: ["issues"],
      installationId: 4242,
    });
    expect(f.breaker.setPermissionLatch).toHaveBeenCalledWith(
      expect.objectContaining({ permission: "issues" }),
    );
  });

  it("fixLoop reports a missing checks read", async () => {
    const f = fixture();
    f.getPermissions.mockResolvedValue({
      installationId: 4242,
      permissions: {
        pull_requests: "write",
        contents: "write",
        actions: "read",
      },
    });
    expect(await run(f, "fixLoop")).toMatchObject({
      ok: false,
      missing: ["checks"],
    });
  });

  it("fixLoop with everything present is ok (write satisfies read)", async () => {
    const f = fixture();
    f.getPermissions.mockResolvedValue({
      installationId: 4242,
      permissions: {
        pull_requests: "write",
        contents: "write",
        checks: "write",
        actions: "read",
      },
    });
    expect(await run(f, "fixLoop")).toMatchObject({ ok: true });
    expect(SELF_HEAL_CAPABILITIES.fixLoop).toHaveLength(4);
  });

  it("a 5xx yields unavailable and no latch change", async () => {
    const f = fixture();
    f.getPermissions.mockRejectedValue(
      Object.assign(new Error("boom"), { status: 503 }),
    );
    expect(await run(f)).toEqual({ ok: false, unavailable: true });
    expect(f.breaker.setPermissionLatch).not.toHaveBeenCalled();
    expect(f.breaker.clearPermissionLatch).not.toHaveBeenCalled();
  });

  it("a latch row updated 20 minutes ago answers without a GitHub call", async () => {
    const f = fixture({
      [`${KEY}:issues`]: row(
        "issues",
        "closed",
        new Date(NOW.getTime() - 20 * 60_000),
      ),
    });
    expect(await run(f)).toEqual({ ok: true, installationId: 4242 });
    expect(f.getPermissions).not.toHaveBeenCalled();
  });

  it("a fresh open latch row reports missing without a GitHub call", async () => {
    const f = fixture({
      [`${KEY}:issues`]: row(
        "issues",
        "open",
        new Date(NOW.getTime() - 20 * 60_000),
      ),
    });
    expect(await run(f)).toMatchObject({ ok: false, missing: ["issues"] });
    expect(f.getPermissions).not.toHaveBeenCalled();
  });

  it("a latch row updated 70 minutes ago triggers one call", async () => {
    const f = fixture({
      [`${KEY}:issues`]: row(
        "issues",
        "open",
        new Date(NOW.getTime() - 70 * 60_000),
      ),
    });
    f.getPermissions.mockResolvedValue({
      installationId: 4242,
      permissions: { issues: "write" },
    });
    expect(await run(f)).toMatchObject({ ok: true });
    expect(f.getPermissions).toHaveBeenCalledTimes(1);
    expect(f.breaker.clearPermissionLatch).toHaveBeenCalled();
  });
});
