import { NextRequest } from "next/server";
import { nanoid } from "nanoid";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getClaudeOauthAccessToken } from "@/agent/msg/claudeCredentials";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { db } from "@/lib/db";
import type { DaemonTokenContext } from "@/lib/daemon-token-context";
import { env } from "@terragon/env/apps-www";
import {
  RUNC_REQUIRED_CHECKS,
  buildConformanceEvidence,
  passingRuncChecks,
} from "@terragon/sandbox/conformance-evidence";
import { verifyBearer } from "@terragon/shared/model/cell-authority";
import {
  insertProfileEvidenceRows,
  upsertExecutionProfile,
} from "@terragon/shared/model/execution-profiles";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { POST } from "./route";

vi.mock("@/lib/auth-server", () => ({ getDaemonTokenContext: vi.fn() }));
vi.mock("@/agent/msg/claudeCredentials", () => ({
  getClaudeOauthAccessToken: vi.fn(),
}));
const noEvidence = vi.hoisted(() => ({ on: false }));

vi.mock("@terragon/shared/model/execution-profiles", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@terragon/shared/model/execution-profiles")
    >();
  return {
    ...actual,
    // Evidence rows cannot be deleted and sibling test files share the database.
    getCurrentProfileEvidence: (
      args: Parameters<typeof actual.getCurrentProfileEvidence>[0],
    ) =>
      noEvidence.on
        ? Promise.resolve([])
        : actual.getCurrentProfileEvidence(args),
  };
});
vi.mock("@terragon/shared/model/feature-flags", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@terragon/shared/model/feature-flags")
  >()),
  getFeatureFlagForUser: vi.fn(),
}));

const OAUTH_TOKEN = "oauth-token-canary-9f3a";
const PROFILE_ID = "opensandbox/runc";

function setCellsEnv(on: boolean): void {
  const e = env as { OPENSANDBOX_URL: string; OPENSANDBOX_API_KEY: string };
  e.OPENSANDBOX_URL = on ? "http://127.0.0.1:18090" : "";
  e.OPENSANDBOX_API_KEY = on ? "test-key" : "";
}

async function seedEvidence(): Promise<void> {
  await insertProfileEvidenceRows({
    db,
    rows: buildConformanceEvidence({
      profileId: PROFILE_ID,
      allowlist: ["api.anthropic.com", "app.example.test"],
      checks: passingRuncChecks(),
      measuredAt: new Date(Date.now() - 2 * 3600_000),
      platformSha: "a".repeat(40),
      artifactDigest: `sha256:${"d".repeat(64)}`,
      required: RUNC_REQUIRED_CHECKS,
    }),
  });
}

/** The broker or model credential of a returned plan's vault. */
function vaultCredential(
  plan: { vault: Array<{ name: string; credential: string }> },
  name: "broker" | "model",
): string {
  const entry = plan.vault.find((v) => v.name === name);
  if (!entry) throw new Error(`no ${name} vault entry`);
  return entry.credential;
}

function req(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/daemon/cell-plan", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "X-Daemon-Token": "tok", "content-type": "application/json" },
  });
}

describe("POST /api/daemon/cell-plan", () => {
  let userId: string;
  let orgId: string;
  let threadId: string;
  let threadChatId: string;
  let apiKeyId: string;
  const ctx = (over: Partial<DaemonTokenContext> = {}): DaemonTokenContext => ({
    userId,
    apiKeyId,
    organizationId: orgId,
    threadChatId,
    threadId,
    tokenType: "daemon",
    ...over,
  });
  const body = (over: Record<string, unknown> = {}) => ({
    threadId,
    threadChatId,
    attempt: 1,
    worker: "w1",
    epoch: "7",
    ...over,
  });
  const steps = async () =>
    (await db.query.cellStep.findMany()).filter(
      (s) => s.stepKey === `cell:${apiKeyId}`,
    );

  async function newThread(
    overrides: Record<string, unknown> = {},
    chatOverrides?: { agent: "codex" },
  ) {
    return createTestThread({
      db,
      userId,
      overrides:
        Object.keys(overrides).length > 0 ? (overrides as never) : undefined,
      chatOverrides,
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
    setCellsEnv(true);
    vi.mocked(getFeatureFlagForUser).mockResolvedValue(true);
    vi.mocked(getClaudeOauthAccessToken).mockResolvedValue(OAUTH_TOKEN);
    userId = (await createTestUser({ db })).user.id;
    orgId = await createTestOrg({ db });
    apiKeyId = `apikey_${nanoid(10)}`;
    const t = await newThread({ organizationId: orgId });
    threadId = t.threadId;
    threadChatId = t.threadChatId;
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx());
    await upsertExecutionProfile({
      db,
      id: PROFILE_ID,
      provider: "opensandbox",
      tier: "customer_box",
      configuration: { egress_mode: "enforce" },
    });
  });

  it("409 egress_not_enforced for a profile without evidence, and no step is opened", async () => {
    noEvidence.on = true;
    try {
      const res = await POST(req(body()));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "egress_not_enforced" });
    } finally {
      noEvidence.on = false;
    }
    expect(await steps()).toEqual([]);
  });

  describe("with evidence", () => {
    beforeEach(seedEvidence);

    it("returns a plan with tags, policy and a model + broker vault", async () => {
      const res = await POST(req(body()));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const { plan } = await res.json();
      expect(plan.tags).toMatchObject({
        automata: "cell",
        stepKey: `cell:${apiKeyId}`,
        attempt: "1",
        worker: "w1",
        epoch: "7",
      });
      expect(plan.networkPolicy.defaultAction).toBe("deny");
      expect(plan.vault.map((v: { name: string }) => v.name).sort()).toEqual([
        "broker",
        "model",
      ]);
      expect(vaultCredential(plan, "model")).toBe(OAUTH_TOKEN);
      expect((await steps())[0]?.currentAttempt).toBe(1);
    });

    it("attempt 2 fences attempt 1: its bearer stops verifying, attempt 1 is stale", async () => {
      const first = await (await POST(req(body()))).json();
      const bearer1 = vaultCredential(first.plan, "broker");
      expect((await verifyBearer({ db, token: bearer1 })).ok).toBe(true);

      const second = await POST(req(body({ attempt: 2 })));
      expect(second.status).toBe(200);
      expect((await verifyBearer({ db, token: bearer1 })).ok).toBe(false);

      const stale = await POST(req(body({ attempt: 1 })));
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: "stale_attempt" });
    });

    it("never logs the model token or the bearer", async () => {
      const spies = (["log", "warn", "error", "info"] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => undefined),
      );
      const res = await POST(req(body()));
      const { plan } = await res.json();
      const bearer = vaultCredential(plan, "broker");
      const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
      expect(logged).not.toContain(OAUTH_TOKEN);
      expect(logged).not.toContain(bearer);
      spies.forEach((s) => s.mockRestore());
    });

    it("422 no_model_credential when there is no OAuth token, and no step", async () => {
      vi.mocked(getClaudeOauthAccessToken).mockResolvedValueOnce(null);
      const res = await POST(req(body()));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "no_model_credential" });
      expect(await steps()).toEqual([]);
    });

    it("a failure of the credential lookup is a server fault, not a 422", async () => {
      vi.mocked(getClaudeOauthAccessToken).mockRejectedValueOnce(
        new Error("db down"),
      );
      await expect(POST(req(body()))).rejects.toThrow("db down");
      expect(await steps()).toEqual([]);
    });

    it("422 agent_not_supported for a non-Claude chat", async () => {
      const t = await newThread({ organizationId: orgId }, { agent: "codex" });
      threadId = t.threadId;
      threadChatId = t.threadChatId;
      vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx());
      const res = await POST(req(body()));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "agent_not_supported" });
      expect(await steps()).toEqual([]);
    });

    it("403 org_required for an org-less thread", async () => {
      const t = await newThread();
      threadId = t.threadId;
      threadChatId = t.threadChatId;
      vi.mocked(getDaemonTokenContext).mockResolvedValue(
        ctx({ organizationId: null }),
      );
      const res = await POST(req(body()));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "org_required" });
    });

    it("404 cells_disabled when the flag is off or the env is unset", async () => {
      vi.mocked(getFeatureFlagForUser).mockResolvedValue(false);
      expect((await POST(req(body()))).status).toBe(404);
      vi.mocked(getFeatureFlagForUser).mockResolvedValue(true);
      setCellsEnv(false);
      const res = await POST(req(body()));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "cells_disabled" });
      expect(await steps()).toEqual([]);
    });

    it("401 without a token; 403 for a non-daemon token, a mismatch or a null apiKeyId", async () => {
      vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(null);
      expect((await POST(req(body()))).status).toBe(401);

      const refusals: Array<[Partial<DaemonTokenContext>, string]> = [
        [{ tokenType: null }, "Forbidden"],
        [{ threadChatId: "other-chat" }, "Forbidden"],
        [{ threadId: "other-thread" }, "Forbidden"],
        [{ threadId: null }, "Forbidden"], // strict binding
        [{ organizationId: "other-org" }, "Forbidden"],
        [{ apiKeyId: null }, "no_run_key"],
      ];
      for (const [over, error] of refusals) {
        vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(ctx(over));
        const res = await POST(req(body()));
        expect(res.status, JSON.stringify(over)).toBe(403);
        expect(await res.json(), JSON.stringify(over)).toEqual({ error });
      }
      expect(await steps()).toEqual([]);
    });

    it("400 Invalid body for a null, array or non-object JSON body", async () => {
      for (const raw of ["null", "[]", '"x"', "7"]) {
        const res = await POST(
          new NextRequest("http://localhost/api/daemon/cell-plan", {
            method: "POST",
            body: raw,
            headers: { "X-Daemon-Token": "tok" },
          }),
        );
        expect(res.status, raw).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid body" });
      }
    });

    it("400 for an out-of-range attempt or an extra field", async () => {
      expect((await POST(req(body({ attempt: 0 })))).status).toBe(400);
      expect((await POST(req(body({ attempt: 1001 })))).status).toBe(400);
      expect((await POST(req(body({ extra: 1 })))).status).toBe(400);
      expect((await POST(req(body({ worker: "Bad Worker" })))).status).toBe(
        400,
      );
    });
  });
});
