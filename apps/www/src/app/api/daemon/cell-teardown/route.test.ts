import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { mintDaemonToken, retireDaemonTokenById } from "@/lib/daemon-token";
import { postOpsAlert } from "@/server-lib/knowledge/ops-alert";
import { mockWaitUntil, waitUntilResolved } from "@/test-helpers/mock-next";
import {
  apikey as apikeyTable,
  cellStep,
  controlEffects,
} from "@terragon/shared/db/schema";
import {
  mintBearer,
  openNextAttempt,
} from "@terragon/shared/model/cell-authority";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { cellStepKey } from "@terragon/types/cell";

import { POST } from "./route";

// Real auth and real database: nothing from `@/lib/auth-server` is mocked, so
// the retired-token acceptance goes through the real verify. Only the ops
// alert is stubbed, and the sandbox package fails on any use (no provider call).
vi.mock("@/server-lib/knowledge/ops-alert", () => ({
  postOpsAlert: vi.fn(),
}));
vi.mock("@terragon/sandbox", () => ({
  default: undefined,
  ...new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then" || prop === "__esModule") return undefined;
        throw new Error(`provider used: ${String(prop)}`);
      },
    },
  ),
}));

describe("POST /api/daemon/cell-teardown", () => {
  let userId: string;
  let orgId: string;
  let threadId: string;
  let threadChatId: string;
  let runKey: string;
  let token: string;
  let apiKeyId: string;
  let stepKey: string;

  const nonce = (c: string) => `nonce-${c.repeat(16)}`;

  function req(body: unknown, withToken: string | null = token): NextRequest {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (withToken !== null) headers["X-Daemon-Token"] = withToken;
    return new NextRequest("http://localhost/api/daemon/cell-teardown", {
      method: "POST",
      body: JSON.stringify(body),
      headers,
    });
  }
  const ids = () => ({ threadId, threadChatId });
  const revoke = (attempt: number) => ({
    ...ids(),
    action: "revoke",
    attempt,
  });
  const clean = (attempt = 1) => ({
    ...ids(),
    action: "report",
    attempt,
    outcome: "clean",
  });
  const incomplete = (attempt = 1, failedSteps = ["delete", "vault"]) => ({
    ...ids(),
    action: "report",
    attempt,
    outcome: "incomplete",
    failedSteps,
  });

  async function open(c: string): Promise<number> {
    const opened = await openNextAttempt({
      db,
      step: {
        stepKey,
        organizationId: orgId,
        threadId,
        stepTimeoutMs: 60_000,
        effectBudget: null,
        allowedRef: null,
        nonce: nonce(c),
      },
    });
    if (!opened.ok) throw new Error(`open refused: ${opened.reason}`);
    return opened.attempt;
  }
  async function step() {
    const [row] = await db
      .select()
      .from(cellStep)
      .where(eq(cellStep.stepKey, stepKey));
    return row;
  }
  async function tokenRow(id = apiKeyId) {
    const [row] = await db
      .select({ name: apikeyTable.name })
      .from(apikeyTable)
      .where(eq(apikeyTable.id, id));
    return row;
  }
  async function ledgerRows() {
    return db
      .select()
      .from(controlEffects)
      .where(eq(controlEffects.step, stepKey));
  }
  async function mintFor(name: string): Promise<{ token: string; id: string }> {
    const raw = await mintDaemonToken({
      userId,
      threadId,
      threadChatId,
      name,
    });
    const [row] = await db
      .select({ id: apikeyTable.id })
      .from(apikeyTable)
      .where(
        and(eq(apikeyTable.referenceId, userId), eq(apikeyTable.name, name)),
      );
    if (!row) throw new Error("minted token not found");
    return { token: raw, id: row.id };
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(postOpsAlert).mockReset();
    vi.mocked(postOpsAlert).mockResolvedValue({ sent: true });
    await mockWaitUntil();
    userId = (await createTestUser({ db })).user.id;
    orgId = (
      await createOrganization({
        db,
        name: "Org",
        slug: `org-${nanoid(8).toLowerCase()}`,
      })
    ).id;
    const t = await createTestThread({
      db,
      userId,
      overrides: { organizationId: orgId },
    });
    threadId = t.threadId;
    threadChatId = t.threadChatId;
    runKey = `${threadId}:${threadChatId}`;
    const minted = await mintFor(runKey);
    token = minted.token;
    apiKeyId = minted.id;
    stepKey = cellStepKey(apiKeyId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("refusals (no authority write)", () => {
    async function expectNoWrite() {
      expect((await step())?.revokedThrough ?? null).toBeNull();
      expect(postOpsAlert).not.toHaveBeenCalled();
    }

    it("401 without a token or with an unknown token", async () => {
      await open("a");
      expect((await POST(req(revoke(1), null))).status).toBe(401);
      expect((await POST(req(revoke(1), `unknown-${nanoid(32)}`))).status).toBe(
        401,
      );
      await expectNoWrite();
    });

    it("403 for a non-daemon token", async () => {
      await open("a");
      const created = await auth.api.createApiKey({
        body: { name: `cli-${nanoid(6)}`, userId, expiresIn: 60 * 60 * 24 },
      });
      expect((await POST(req(revoke(1), created.key))).status).toBe(403);
      await expectNoWrite();
    });

    it("403 for a token bound to another threadChat, or with a null thread id (strict)", async () => {
      await open("a");
      expect(
        (await POST(req({ ...revoke(1), threadChatId: "tc_other" }))).status,
      ).toBe(403);
      const noThread = await auth.api.createApiKey({
        body: {
          name: `nothread-${nanoid(6)}`,
          userId,
          expiresIn: 60 * 60 * 24,
          metadata: {
            organizationId: orgId,
            threadChatId,
            tokenType: "daemon",
          },
        },
      });
      expect((await POST(req(revoke(1), noThread.key))).status).toBe(403);
      await expectNoWrite();
    });

    it("403 for a foreign owner or a foreign org", async () => {
      await open("a");
      const other = (await createTestUser({ db })).user;
      const foreignOwner = await auth.api.createApiKey({
        body: {
          name: `owner-${nanoid(6)}`,
          userId: other.id,
          expiresIn: 60 * 60 * 24,
          metadata: {
            organizationId: orgId,
            threadChatId,
            threadId,
            tokenType: "daemon",
          },
        },
      });
      expect((await POST(req(revoke(1), foreignOwner.key))).status).toBe(403);
      const foreignOrg = await auth.api.createApiKey({
        body: {
          name: `org-${nanoid(6)}`,
          userId,
          expiresIn: 60 * 60 * 24,
          metadata: {
            organizationId: "some-other-org",
            threadChatId,
            threadId,
            tokenType: "daemon",
          },
        },
      });
      expect((await POST(req(revoke(1), foreignOrg.key))).status).toBe(403);
      await expectNoWrite();
    });

    it("503 when auth is unavailable", async () => {
      await open("a");
      vi.spyOn(auth.api, "verifyApiKey").mockRejectedValue(
        new Error("connection terminated"),
      );
      const res = await POST(req(revoke(1)));
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("2");
      vi.restoreAllMocks();
      await expectNoWrite();
    });
  });

  describe("schema", () => {
    it.each([
      ["an unknown key", () => ({ ...revoke(1), extra: 1 })],
      ["an unknown action", () => ({ ...ids(), action: "nuke", attempt: 1 })],
      ["attempt 0", () => revoke(0)],
      ["attempt 1001", () => revoke(1001)],
      [
        "incomplete without failedSteps",
        () => ({
          ...ids(),
          action: "report",
          attempt: 1,
          outcome: "incomplete",
        }),
      ],
      ["an unknown step name", () => incomplete(1, ["vault", "teleport"])],
      ["a duplicate step", () => incomplete(1, ["vault", "vault"])],
      ["an empty failedSteps", () => incomplete(1, [])],
      [
        "clean with failedSteps",
        () => ({ ...clean(1), failedSteps: ["vault"] }),
      ],
    ])("%s answers 400 invalid_body", async (_label, body) => {
      const res = await POST(req(body()));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("a null apiKeyId answers 403 no_run_key", async () => {
      const real = auth.api.verifyApiKey.bind(auth.api);
      vi.spyOn(auth.api, "verifyApiKey").mockImplementation((async (
        args: Parameters<typeof real>[0],
      ) => {
        const result = await real(args);
        return result.key
          ? { ...result, key: { ...result.key, id: "" } }
          : result;
      }) as unknown as typeof auth.api.verifyApiKey);
      const res = await POST(req(revoke(1)));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "no_run_key" });
    });
  });

  describe("revoke", () => {
    it("is idempotent: two calls answer 200 with revoked_through at the attempt", async () => {
      const attempt = await open("a");
      for (let i = 0; i < 2; i++) {
        const res = await POST(req(revoke(attempt)));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, revoked: true });
      }
      expect((await step())?.revokedThrough).toBe(attempt);
    });

    it("revoking fenced attempt 1 while 2 is current leaves 2 unrevoked (control)", async () => {
      await open("a");
      await open("b");
      await POST(req(revoke(1)));
      expect((await step())?.revokedThrough).toBe(1);
      await POST(req(revoke(2)));
      expect((await step())?.revokedThrough).toBe(2);
    });

    it("an unknown step answers 200 revoked:false", async () => {
      const res = await POST(req(revoke(1)));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, revoked: false });
    });

    it("answers 200 with no flag gate (the route never reads the cells flag)", async () => {
      const attempt = await open("a");
      const res = await POST(req(revoke(attempt)));
      expect(res.status).toBe(200);
    });
  });

  describe("a retired token is accepted here only", () => {
    it("answers 200 on revoke and on report with a retired token", async () => {
      const attempt = await open("a");
      expect(await retireDaemonTokenById({ userId, apiKeyId })).toBe(true);
      expect((await POST(req(revoke(attempt)))).status).toBe(200);
      expect((await POST(req(clean(attempt)))).status).toBe(200);
    });
  });

  describe("report", () => {
    it("clean: no alert and no event line", async () => {
      const attempt = await open("a");
      const errorSpy = vi.spyOn(console, "error");
      const res = await POST(req(clean(attempt)));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(postOpsAlert).not.toHaveBeenCalled();
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(
        "cell_teardown_incomplete",
      );
    });

    it("incomplete: one event with the canonical first step, one alert, no repeat alert", async () => {
      const attempt = await open("a");
      const errorSpy = vi.spyOn(console, "error");
      const events = () =>
        errorSpy.mock.calls.filter(
          (c) => c[0] === "[cell] cell_teardown_incomplete",
        );

      const first = await POST(req(incomplete(attempt, ["delete", "vault"])));
      expect(first.status).toBe(200);
      expect(events()).toHaveLength(1);
      expect(events()[0]?.[1]).toEqual({
        event: "cell_teardown_incomplete",
        stepKey,
        attempt,
        failedStep: "vault",
        failedSteps: ["delete", "vault"],
      });
      expect(postOpsAlert).toHaveBeenCalledTimes(1);

      await POST(req(incomplete(attempt, ["delete", "vault"])));
      expect(events()).toHaveLength(2);
      expect(postOpsAlert).toHaveBeenCalledTimes(1);
    });

    it("a transient alert failure leaves the intent and the next report sends it", async () => {
      const attempt = await open("a");
      vi.mocked(postOpsAlert).mockResolvedValueOnce({
        sent: false,
        reason: "timeout",
      });
      const first = await POST(req(incomplete(attempt)));
      expect(first.status).toBe(200);
      const rows = await ledgerRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.doneAt).toBeNull();

      await POST(req(incomplete(attempt)));
      expect(postOpsAlert).toHaveBeenCalledTimes(2);
      expect((await ledgerRows())[0]?.doneAt).not.toBeNull();
    });

    it("carries no secret: not the token, a bearer, or the model token", async () => {
      const attempt = await open("a");
      const bearer = await mintBearer({
        db,
        stepKey,
        attempt,
        ttlMs: 30_000,
      });
      if (!bearer.ok) throw new Error(`mint refused: ${bearer.reason}`);
      const modelToken = `model-canary-${nanoid(24)}`;
      const logSpy = vi.spyOn(console, "log");
      const errorSpy = vi.spyOn(console, "error");

      await POST(req(incomplete(attempt, ["survivor"])));

      const seen = JSON.stringify([
        logSpy.mock.calls,
        errorSpy.mock.calls,
        vi.mocked(postOpsAlert).mock.calls,
      ]);
      for (const canary of [token, bearer.token, modelToken]) {
        expect(seen).not.toContain(canary);
      }
      const alertText = vi.mocked(postOpsAlert).mock.calls[0]?.[0].text;
      expect(alertText).toBe(
        `cell teardown incomplete: step ${stepKey}, attempt ${attempt}, failed survivor`,
      );
    });

    it("an alert with sent:false (unconfigured) still answers 200", async () => {
      const attempt = await open("a");
      vi.mocked(postOpsAlert).mockResolvedValue({
        sent: false,
        reason: "unconfigured",
      });
      expect((await POST(req(incomplete(attempt)))).status).toBe(200);
    });

    it("attempt bound: above the current attempt logs the event, alerts nothing, writes no ledger row (control: attempt 2 alerts)", async () => {
      await open("a");
      await open("b");
      const errorSpy = vi.spyOn(console, "error");

      const above = await POST(req(incomplete(5)));
      expect(above.status).toBe(200);
      expect(postOpsAlert).not.toHaveBeenCalled();
      expect(await ledgerRows()).toHaveLength(0);
      expect(
        errorSpy.mock.calls.some(
          (c) =>
            c[0] === "[cell] cell_teardown_incomplete" &&
            (c[1] as { alert?: string }).alert === "skipped_unknown_attempt",
        ),
      ).toBe(true);

      await POST(req(incomplete(2)));
      expect(postOpsAlert).toHaveBeenCalledTimes(1);
      expect(await ledgerRows()).toHaveLength(1);
    });

    it("an unknown step logs the event and alerts nothing", async () => {
      await POST(req(incomplete(1)));
      expect(postOpsAlert).not.toHaveBeenCalled();
      expect(await ledgerRows()).toHaveLength(0);
    });
  });

  describe("token custody", () => {
    it("after a terminal read, report deletes the retired token and a second report gets 401", async () => {
      const attempt = await open("a");
      await retireDaemonTokenById({ userId, apiKeyId });

      expect((await POST(req(clean(attempt)))).status).toBe(200);
      await waitUntilResolved();
      expect(await tokenRow()).toBeUndefined();
      expect((await POST(req(clean(attempt)))).status).toBe(401);
    });

    it("without a terminal read, report leaves the live token and a second report answers 200 (control)", async () => {
      const attempt = await open("a");
      expect((await POST(req(clean(attempt)))).status).toBe(200);
      await waitUntilResolved();
      expect(await tokenRow()).toEqual({ name: runKey });
      expect((await POST(req(clean(attempt)))).status).toBe(200);
    });
  });

  it("makes no provider call: the sandbox package is never used", async () => {
    const attempt = await open("a");
    // The mocked package throws on any property access.
    expect((await POST(req(revoke(attempt)))).status).toBe(200);
    expect((await POST(req(incomplete(attempt)))).status).toBe(200);
    expect((await POST(req(clean(attempt)))).status).toBe(200);
  });
});
