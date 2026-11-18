import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { DaemonAuthUnavailableError } from "@/lib/daemon-auth-unavailable";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  apikey as apikeyTable,
  cellStep,
  thread as threadTable,
} from "@terragon/shared/db/schema";
import { and, eq } from "drizzle-orm";
import {
  finishStep,
  openNextAttempt,
  stampSeen,
} from "@terragon/shared/model/cell-authority";
import { cellStepKey } from "@terragon/types/cell";
import { postOpsAlert } from "@/server-lib/knowledge/ops-alert";
import { nanoid } from "nanoid";
import { User } from "@terragon/shared";
import { DaemonTokenContext } from "@/lib/daemon-token-context";
import {
  hasActiveDaemonToken,
  mintDaemonToken,
  retireDaemonTokenById,
  revokeDaemonTokenById,
} from "@/lib/daemon-token";

vi.mock("@/lib/auth-server", () => ({ getDaemonTokenContext: vi.fn() }));
vi.mock("@/lib/daemon-token", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  const real = actual as typeof import("@/lib/daemon-token");
  return {
    ...actual,
    revokeDaemonTokenById: vi.fn().mockResolvedValue(1),
    retireDaemonTokenById: vi.fn(real.retireDaemonTokenById),
  };
});
vi.mock("@terragon/shared/model/cell-authority", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@terragon/shared/model/cell-authority");
  return {
    ...actual,
    finishStep: vi.fn(actual.finishStep),
    stampSeen: vi.fn(actual.stampSeen),
  };
});
vi.mock("@/server-lib/knowledge/ops-alert", () => ({
  postOpsAlert: vi.fn().mockResolvedValue({ sent: true }),
}));

function req(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/daemon/thread-status", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "X-Daemon-Token": "tok", "content-type": "application/json" },
  });
}

describe("POST /api/daemon/thread-status", () => {
  let user: User;
  let orgId: string;
  let threadId: string;
  let threadChatId: string;

  function ctx(over: Partial<DaemonTokenContext> = {}): DaemonTokenContext {
    return {
      userId: user.id,
      apiKeyId: "apikey_test",
      organizationId: orgId,
      threadChatId,
      threadId,
      tokenType: "daemon",
      retired: false,
      ...over,
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    const org = await createOrganization({
      db,
      name: "Org",
      slug: `org-${nanoid(8).toLowerCase()}`,
    });
    orgId = org.id;
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: orgId },
    });
    threadId = t.threadId;
    threadChatId = t.threadChatId;
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx());
    vi.mocked(postOpsAlert).mockResolvedValue({ sent: true });
  });

  it("503 + Retry-After (never 401) when daemon auth is unavailable", async () => {
    vi.mocked(getDaemonTokenContext).mockRejectedValueOnce(
      new DaemonAuthUnavailableError("api key lookup failed"),
    );
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(await res.json()).toEqual({
      error: "Authentication temporarily unavailable",
    });
  });

  it("401 without a token; 403 for a non-daemon token", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(null);
    expect((await POST(req({ threadId, threadChatId }))).status).toBe(401);
    vi.mocked(getDaemonTokenContext).mockResolvedValue(
      ctx({ tokenType: null }),
    );
    expect((await POST(req({ threadId, threadChatId }))).status).toBe(403);
  });

  it("F2: 403 when the token is bound to a different threadChat", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(
      ctx({ threadChatId: "tc_other" }),
    );
    expect((await POST(req({ threadId, threadChatId }))).status).toBe(403);
  });

  it("403 when the token's org != the thread's org", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(
      ctx({ organizationId: "other-org" }),
    );
    expect((await POST(req({ threadId, threadChatId }))).status).toBe(403);
  });

  it("reports terminal=false while working and terminal=true when complete", async () => {
    await db
      .update(threadTable)
      .set({ status: "working" })
      .where(eq(threadTable.id, threadId));
    let res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "working", terminal: false });

    await db
      .update(threadTable)
      .set({ status: "complete" })
      .where(eq(threadTable.id, threadId));
    res = await POST(req({ threadId, threadChatId }));
    expect(await res.json()).toEqual({ status: "complete", terminal: true });
  });

  it("revoke-on-terminal-READ: revokes the token ONLY when serving terminal=true", async () => {
    // While working → terminal=false → token stays live (worker keeps polling).
    await db
      .update(threadTable)
      .set({ status: "working" })
      .where(eq(threadTable.id, threadId));
    await POST(req({ threadId, threadChatId }));
    expect(revokeDaemonTokenById).not.toHaveBeenCalled();

    // Terminal → the worker observes terminal=true, THEN the token is revoked.
    await db
      .update(threadTable)
      .set({ status: "complete" })
      .where(eq(threadTable.id, threadId));
    await POST(req({ threadId, threadChatId }));
    expect(revokeDaemonTokenById).toHaveBeenCalledWith({
      userId: user.id,
      apiKeyId: "apikey_test",
    });
  });

  it("does NOT revoke on terminal read for a legacy token with no apiKeyId", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx({ apiKeyId: null }));
    await db
      .update(threadTable)
      .set({ status: "complete" })
      .where(eq(threadTable.id, threadId));
    await POST(req({ threadId, threadChatId }));
    expect(revokeDaemonTokenById).not.toHaveBeenCalled();
  });

  describe("cell runs (cellAttempt)", () => {
    let runKey: string;
    let apiKeyId: string;

    async function setWorking() {
      await db
        .update(threadTable)
        .set({ status: "working" })
        .where(eq(threadTable.id, threadId));
    }
    async function setComplete() {
      await db
        .update(threadTable)
        .set({ status: "complete" })
        .where(eq(threadTable.id, threadId));
    }
    async function open(nonce: string, forThread = threadId) {
      const opened = await openNextAttempt({
        db,
        step: {
          stepKey: cellStepKey(apiKeyId),
          organizationId: orgId,
          threadId: forThread,
          stepTimeoutMs: 60_000,
          effectBudget: null,
          allowedRef: null,
          nonce,
        },
      });
      if (!opened.ok) throw new Error(`open refused: ${opened.reason}`);
      return opened.attempt;
    }
    async function stepRow() {
      const [row] = await db
        .select()
        .from(cellStep)
        .where(eq(cellStep.stepKey, cellStepKey(apiKeyId)));
      return row;
    }
    async function backdateLease() {
      await db
        .update(cellStep)
        .set({ lastSeenAt: new Date(Date.now() - 120_000) })
        .where(eq(cellStep.stepKey, cellStepKey(apiKeyId)));
    }

    beforeEach(async () => {
      runKey = `${threadId}:${threadChatId}`;
      await mintDaemonToken({
        userId: user.id,
        threadId,
        threadChatId,
        name: runKey,
      });
      const [key] = await db
        .select({ id: apikeyTable.id })
        .from(apikeyTable)
        .where(
          and(
            eq(apikeyTable.referenceId, user.id),
            eq(apikeyTable.name, runKey),
          ),
        );
      apiKeyId = key!.id; // minted just above
      vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx({ apiKeyId }));
    });

    it("without cellAttempt a terminal read revokes once and never finishes a step (unchanged path)", async () => {
      await setComplete();
      const res = await POST(req({ threadId, threadChatId }));
      expect(await res.json()).toEqual({ status: "complete", terminal: true });
      expect(revokeDaemonTokenById).toHaveBeenCalledTimes(1);
      expect(retireDaemonTokenById).not.toHaveBeenCalled();
      expect(finishStep).not.toHaveBeenCalled();
      expect(stampSeen).not.toHaveBeenCalled();
    });

    it.each([0, 1.5, "1", 1001, null, -1, true])(
      "400 invalid_cell_attempt for %j, with no stamp and no finish",
      async (cellAttempt) => {
        await setComplete();
        const res = await POST(req({ threadId, threadChatId, cellAttempt }));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid_cell_attempt" });
        expect(stampSeen).not.toHaveBeenCalled();
        expect(finishStep).not.toHaveBeenCalled();
        expect(revokeDaemonTokenById).not.toHaveBeenCalled();
      },
    );

    it("403 no_run_key for a null apiKeyId", async () => {
      vi.mocked(getDaemonTokenContext).mockResolvedValue(
        ctx({ apiKeyId: null }),
      );
      const res = await POST(req({ threadId, threadChatId, cellAttempt: 1 }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "no_run_key" });
    });

    it("a poll with the current attempt renews the lease", async () => {
      await setWorking();
      const attempt = await open("nonce-aaaaaaaaaaaaaaaa");
      await backdateLease();
      const before = (await stepRow())!.lastSeenAt!.getTime();
      const res = await POST(
        req({ threadId, threadChatId, cellAttempt: attempt }),
      );
      expect(await res.json()).toEqual({
        status: "working",
        terminal: false,
        lease: "renewed",
      });
      expect((await stepRow())!.lastSeenAt!.getTime()).toBeGreaterThan(before);
      expect(stampSeen).toHaveBeenCalledWith({
        db,
        stepKey: cellStepKey(apiKeyId),
        attempt,
      });
    });

    it("a fenced attempt's poll renews nothing; the current one does (control)", async () => {
      await setWorking();
      const first = await open("nonce-aaaaaaaaaaaaaaaa");
      const second = await open("nonce-bbbbbbbbbbbbbbbb");
      expect([first, second]).toEqual([1, 2]);
      await backdateLease();
      const before = (await stepRow())!.lastSeenAt!.getTime();

      const fenced = await POST(
        req({ threadId, threadChatId, cellAttempt: 1 }),
      );
      expect((await fenced.json()).lease).toBe("refused");
      expect((await stepRow())!.lastSeenAt!.getTime()).toBe(before);

      const current = await POST(
        req({ threadId, threadChatId, cellAttempt: 2 }),
      );
      expect((await current.json()).lease).toBe("renewed");
      expect((await stepRow())!.lastSeenAt!.getTime()).toBeGreaterThan(before);
    });

    it("stampSeen throwing still serves the status with lease error", async () => {
      await setWorking();
      vi.mocked(stampSeen).mockRejectedValueOnce(new Error("db down"));
      const res = await POST(req({ threadId, threadChatId, cellAttempt: 1 }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "working",
        terminal: false,
        lease: "error",
      });
    });

    it("terminal read: finishes the step, retires (never revokes) the token, frees the dispatch guard", async () => {
      const attempt = await open("nonce-aaaaaaaaaaaaaaaa");
      await setComplete();
      // Control: before the read the run is in flight.
      expect(
        await hasActiveDaemonToken({ userId: user.id, name: runKey }),
      ).toBe(true);

      const res = await POST(
        req({ threadId, threadChatId, cellAttempt: attempt }),
      );
      expect(await res.json()).toEqual({
        status: "complete",
        terminal: true,
        lease: "finished",
      });

      const row = (await stepRow())!;
      expect(row.doneAt).not.toBeNull();
      expect(row.revokedThrough).toBe(row.currentAttempt);
      await expect(
        openNextAttempt({
          db,
          step: {
            stepKey: cellStepKey(apiKeyId),
            organizationId: orgId,
            threadId,
            stepTimeoutMs: 60_000,
            effectBudget: null,
            allowedRef: null,
            nonce: "nonce-cccccccccccccccc",
          },
        }),
      ).resolves.toEqual({ ok: false, reason: "step_done" });

      expect(revokeDaemonTokenById).not.toHaveBeenCalled();
      const [tok] = await db
        .select({ name: apikeyTable.name, expiresAt: apikeyTable.expiresAt })
        .from(apikeyTable)
        .where(eq(apikeyTable.id, apiKeyId));
      expect(tok?.name).toBe(`${runKey}:retired`);
      expect(tok!.expiresAt!.getTime()).toBeLessThan(
        Date.now() + 16 * 60 * 1000,
      );
      expect(
        await hasActiveDaemonToken({ userId: user.id, name: runKey }),
      ).toBe(false);
    });

    it("finishStep throwing answers 500 and retires nothing", async () => {
      await setComplete();
      vi.mocked(finishStep).mockRejectedValueOnce(new Error("db down"));
      const res = await POST(req({ threadId, threadChatId, cellAttempt: 1 }));
      expect(res.status).toBe(500);
      expect(retireDaemonTokenById).not.toHaveBeenCalled();
      expect(revokeDaemonTokenById).not.toHaveBeenCalled();
      expect(
        await hasActiveDaemonToken({ userId: user.id, name: runKey }),
      ).toBe(true);
    });

    it("a failed retire answers 500; a retry then answers 200 finished with the token retired", async () => {
      const attempt = await open("nonce-aaaaaaaaaaaaaaaa");
      await setComplete();
      vi.mocked(retireDaemonTokenById).mockRejectedValueOnce(
        new Error("db down"),
      );
      const failed = await POST(
        req({ threadId, threadChatId, cellAttempt: attempt }),
      );
      expect(failed.status).toBe(500);
      expect(
        await hasActiveDaemonToken({ userId: user.id, name: runKey }),
      ).toBe(true);

      const retried = await POST(
        req({ threadId, threadChatId, cellAttempt: attempt }),
      );
      expect(retried.status).toBe(200);
      expect((await retried.json()).lease).toBe("finished");
      const [tok] = await db
        .select({ name: apikeyTable.name })
        .from(apikeyTable)
        .where(eq(apikeyTable.id, apiKeyId));
      expect(tok?.name).toBe(`${runKey}:retired`);
    });

    it("finishStep false (a foreign step): 409, token revoked not retired, one alert across repeats", async () => {
      const otherThread = await createTestThread({
        db,
        userId: user.id,
        overrides: { organizationId: orgId },
      });
      const attempt = await open(
        "nonce-aaaaaaaaaaaaaaaa",
        otherThread.threadId,
      );
      await setComplete();

      const body = { threadId, threadChatId, cellAttempt: attempt };
      const first = await POST(req(body));
      expect(first.status).toBe(409);
      expect(await first.json()).toEqual({ error: "cell_step_conflict" });
      expect(retireDaemonTokenById).not.toHaveBeenCalled();
      expect(revokeDaemonTokenById).toHaveBeenCalledWith({
        userId: user.id,
        apiKeyId,
      });
      expect(postOpsAlert).toHaveBeenCalledTimes(1);

      const second = await POST(req(body));
      expect(second.status).toBe(409);
      expect(postOpsAlert).toHaveBeenCalledTimes(1);
      // The foreign step is untouched.
      expect((await stepRow())!.doneAt).toBeNull();
    });

    it("a conflict for an attempt above the step's current one sends no alert", async () => {
      const otherThread = await createTestThread({
        db,
        userId: user.id,
        overrides: { organizationId: orgId },
      });
      await open("nonce-aaaaaaaaaaaaaaaa", otherThread.threadId);
      await setComplete();
      const res = await POST(req({ threadId, threadChatId, cellAttempt: 7 }));
      expect(res.status).toBe(409);
      expect(postOpsAlert).not.toHaveBeenCalled();
    });

    it("the step key is cellStepKey(apiKeyId), asserted through the helper", async () => {
      await setComplete();
      await POST(req({ threadId, threadChatId, cellAttempt: 1 }));
      expect(finishStep).toHaveBeenCalledWith({
        db,
        stepKey: cellStepKey(apiKeyId),
        organizationId: orgId,
        threadId,
      });
    });
  });
});
