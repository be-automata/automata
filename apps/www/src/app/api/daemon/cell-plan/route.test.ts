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
import { buildDaemonVaultEntry } from "@terragon/shared/model/cell-create-plan";
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

import { cellBrokerHost } from "@/server-lib/compute/cell-gate";
import { CELL_RUN_TTL_MS, cellStepKey } from "@terragon/types/cell";
import { remoteTaskBranchName } from "@/server-lib/task/remote-task-pr";

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
const DAEMON_TOKEN = "daemon-token-canary-7c1e";
const NONCE_A = "request-aaaaaaaaaaaaaaaa";
const NONCE_B = "request-bbbbbbbbbbbbbbbb";

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

function req(
  body: Record<string, unknown>,
  token: string = DAEMON_TOKEN,
): NextRequest {
  return new NextRequest("http://localhost/api/daemon/cell-plan", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "X-Daemon-Token": token, "content-type": "application/json" },
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
    worker: "w1",
    epoch: "7",
    requestId: NONCE_A,
    ...over,
  });
  const steps = async () =>
    (await db.query.cellStep.findMany()).filter(
      (s) => s.stepKey === cellStepKey(apiKeyId),
    );

  // A run being planned is working; the default test chat is a draft (terminal).
  async function newThread(
    overrides: Record<string, unknown> = {},
    chatOverrides: Record<string, unknown> = {},
  ) {
    return createTestThread({
      db,
      userId,
      overrides:
        Object.keys(overrides).length > 0 ? (overrides as never) : undefined,
      chatOverrides: { status: "working", ...chatOverrides } as never,
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
    apiKeyId = nanoid(32).replace(/[^A-Za-z0-9]/g, "a");
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
      const { plan, attempt } = await res.json();
      expect(attempt).toBe(1);
      expect(plan.tags).toMatchObject({
        automata: "cell",
        stepKey: `cell-${apiKeyId}`,
        attempt: "1",
        worker: "w1",
        epoch: "7",
        deployment: cellBrokerHost(),
      });
      expect(plan.ttlMs).toBe(CELL_RUN_TTL_MS);
      expect(plan.networkPolicy.defaultAction).toBe("deny");
      expect(plan.vault.map((v: { name: string }) => v.name).sort()).toEqual([
        "broker",
        "daemon",
        "model",
      ]);
      expect(vaultCredential(plan, "model")).toBe(OAUTH_TOKEN);
      const [row] = await steps();
      expect(row?.currentAttempt).toBe(1);
      // byte-equal to the tag, and the TTL equals the step timeout (AC-16)
      expect(row?.stepKey).toBe(plan.tags.stepKey);
      expect(plan.ttlMs).toBe(row?.stepTimeoutMs);
      expect(row?.stepTimeoutMs).toBe(CELL_RUN_TTL_MS);
      expect(row?.effectBudget).toBe(50);
      expect(row?.allowedRef).toBe(
        `refs/heads/${remoteTaskBranchName(threadId)}`,
      );
      expect(
        plan.vault.find((v: { name: string }) => v.name === "daemon"),
      ).toEqual(buildDaemonVaultEntry(cellBrokerHost(), DAEMON_TOKEN));
    });

    it("a new requestId opens the next attempt and fences the old bearer; a replay keeps one live bearer", async () => {
      const first = await (await POST(req(body()))).json();
      expect(first.attempt).toBe(1);
      const bearer1 = vaultCredential(first.plan, "broker");
      expect((await verifyBearer({ db, token: bearer1 })).ok).toBe(true);

      const second = await (
        await POST(req(body({ requestId: NONCE_B })))
      ).json();
      expect(second.attempt).toBe(2);
      expect((await verifyBearer({ db, token: bearer1 })).ok).toBe(false);
      const bearer2 = vaultCredential(second.plan, "broker");
      expect((await verifyBearer({ db, token: bearer2 })).ok).toBe(true);

      // replaying B: same attempt, bearer 2 dies, the replay's bearer lives
      const replay = await (
        await POST(req(body({ requestId: NONCE_B })))
      ).json();
      expect(replay.attempt).toBe(2);
      const bearer2b = vaultCredential(replay.plan, "broker");
      expect((await verifyBearer({ db, token: bearer2 })).ok).toBe(false);
      expect((await verifyBearer({ db, token: bearer2b })).ok).toBe(true);

      // A is no longer the current attempt's nonce: it opens attempt 3
      const third = await (await POST(req(body()))).json();
      expect(third.attempt).toBe(3);
    });

    it("409 invalid_run_key for an apiKeyId that breaks the label rule, with no step row", async () => {
      for (const bad of ["a:b", "a".repeat(60)]) {
        vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(
          ctx({ apiKeyId: bad }),
        );
        const res = await POST(req(body()));
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "invalid_run_key" });
      }
      expect(
        (await db.query.cellStep.findMany()).filter(
          (r) => r.threadId === threadId,
        ),
      ).toEqual([]);
      // negative control: a 32-char alphanumeric id plans
      expect((await POST(req(body()))).status).toBe(200);
    });

    it.each(["complete", "error", "stopped", "draft", "scheduled"])(
      "409 thread_terminal for a %s chat: no step, no credential lookup",
      async (status) => {
        const t = await newThread({ organizationId: orgId }, { status });
        threadId = t.threadId;
        threadChatId = t.threadChatId;
        vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx());
        const res = await POST(req(body()));
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: "thread_terminal" });
        expect(await steps()).toEqual([]);
        expect(getClaudeOauthAccessToken).not.toHaveBeenCalled();
      },
    );

    it("a booting chat plans (negative control for thread_terminal)", async () => {
      const t = await newThread(
        { organizationId: orgId },
        { status: "booting" },
      );
      threadId = t.threadId;
      threadChatId = t.threadChatId;
      vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx());
      expect((await POST(req(body()))).status).toBe(200);
    });

    it("unknown_profile and egress_not_enforced refuse before the credential lookup", async () => {
      noEvidence.on = true;
      try {
        expect((await POST(req(body()))).status).toBe(409);
      } finally {
        noEvidence.on = false;
      }
      expect(getClaudeOauthAccessToken).not.toHaveBeenCalled();
      expect(await steps()).toEqual([]);
    });

    it("work_branch_unresolved: a PR thread with no branch name never gets the base as allowedRef", async () => {
      const t = await newThread({
        organizationId: orgId,
        githubPRNumber: 5,
        branchName: null,
      });
      threadId = t.threadId;
      threadChatId = t.threadChatId;
      vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx());
      const res = await POST(req(body()));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "work_branch_unresolved" });
      expect(getClaudeOauthAccessToken).not.toHaveBeenCalled();
      expect(await steps()).toEqual([]);
    });

    it("an existing PR on a work branch pushes that branch", async () => {
      const t = await newThread({
        organizationId: orgId,
        githubPRNumber: 5,
        branchName: "automata/task-existing",
      });
      threadId = t.threadId;
      threadChatId = t.threadChatId;
      vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx());
      expect((await POST(req(body()))).status).toBe(200);
      expect((await steps())[0]?.allowedRef).toBe(
        "refs/heads/automata/task-existing",
      );
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
      expect(logged).not.toContain(DAEMON_TOKEN);
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

    it("400 for a body with attempt, without or with a bad requestId, or a bad worker", async () => {
      expect((await POST(req(body({ attempt: 1 })))).status).toBe(400);
      expect((await POST(req(body({ requestId: undefined })))).status).toBe(
        400,
      );
      expect((await POST(req(body({ requestId: "short" })))).status).toBe(400);
      expect((await POST(req(body({ extra: 1 })))).status).toBe(400);
      expect((await POST(req(body({ worker: "Bad Worker" })))).status).toBe(
        400,
      );
      expect((await POST(req(body({ worker: "w1-" })))).status).toBe(400);
      // negative control
      expect((await POST(req(body({ worker: "w1" })))).status).toBe(200);
    });
  });
});
