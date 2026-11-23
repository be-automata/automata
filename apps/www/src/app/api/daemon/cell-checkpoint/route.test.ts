import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDaemonTokenContext } from "@/lib/auth-server";
import type { DaemonTokenContext } from "@/lib/daemon-token-context";
import { db } from "@/lib/db";
import { thread as threadTable } from "@terragon/shared/db/schema";
import {
  openNextAttempt,
  revokeAttempt,
} from "@terragon/shared/model/cell-authority";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { cellStepKey } from "@terragon/types/cell";
import {
  CELL_SESSION_SCHEMA,
  computeManifestId,
  sha256Hex,
  type CellSessionManifest,
} from "@terragon/types/cell-session-checkpoint";

import { POST } from "./route";

vi.mock("@/lib/auth-server", () => ({ getDaemonTokenContext: vi.fn() }));

const store = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  puts: 0,
}));
vi.mock("@/server-lib/r2", () => ({
  r2Private: {
    putObjectIfAbsent: async (
      key: string,
      body: Buffer | Uint8Array | string,
    ) => {
      store.puts += 1;
      if (store.objects.has(key)) return { status: 412 };
      store.objects.set(key, Buffer.from(body));
      return { status: 201 };
    },
    getObjectOrNull: async (key: string) => store.objects.get(key) ?? null,
  },
}));

const SESSION = "11111111-1111-4111-8111-111111111111";
const MIB = 1024 * 1024;

/** Whether JSON.parse was handed anything near a request body (other code parses small strings). */
function parsedLargeText(spy: { mock: { calls: unknown[][] } }): boolean {
  return spy.mock.calls.some(
    (call) => typeof call[0] === "string" && call[0].length > 4096,
  );
}

describe("POST /api/daemon/cell-checkpoint (#743 phase 4)", () => {
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

  function req(
    body: unknown,
    init: { headers?: Record<string, string>; raw?: BodyInit } = {},
  ) {
    return new NextRequest("http://localhost/api/daemon/cell-checkpoint", {
      method: "POST",
      body: init.raw ?? JSON.stringify(body),
      headers: {
        "X-Daemon-Token": "tok",
        "content-type": "application/json",
        ...init.headers,
      },
      ...(init.raw ? { duplex: "half" } : {}),
    } as ConstructorParameters<typeof NextRequest>[1]);
  }

  const ids = (attempt = 1) => ({ threadId, threadChatId, attempt });
  const base = (attempt = 1) => ({ ...ids(attempt), runExternalId: "run-1" });

  async function openStep(key = apiKeyId, forThread = threadId) {
    const r = await openNextAttempt({
      db,
      step: {
        stepKey: cellStepKey(key),
        organizationId: orgId,
        threadId: forThread,
        stepTimeoutMs: 30 * 60_000,
        effectBudget: 50,
        allowedRef: null,
        nonce: nanoid(32),
      },
    });
    if (!r.ok) throw new Error(r.reason);
    return r.attempt;
  }

  function manifest(over: Partial<CellSessionManifest> = {}) {
    const bytes = Buffer.from("turn one\n");
    const sha = sha256Hex(bytes);
    const rest: Omit<CellSessionManifest, "id"> = {
      schema: CELL_SESSION_SCHEMA,
      threadId,
      threadChatId,
      sessionId: SESSION,
      parent: null,
      turn: 1,
      runExternalId: "run-1",
      createdAt: "2026-11-22T00:00:00.000Z",
      harness: { name: "claude-code", nativeFormat: "claude-jsonl" },
      projectDir: "-workspace",
      git: null,
      native: {
        sha256: sha,
        bytes: bytes.length,
        chunks: [{ sha256: sha, bytes: bytes.length }],
      },
      events: { count: 0, chunks: [] },
      redaction: { rulesDigest: "d", hits: 0 },
      ...over,
    };
    return { ...rest, id: computeManifestId(rest) };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    store.objects.clear();
    store.puts = 0;
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
    apiKeyId = `apikey_${nanoid(10)}`;
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx());
  });

  describe("F3: size before parse", () => {
    it("413 on an oversized content-length, without reading the body", async () => {
      const parse = vi.spyOn(JSON, "parse");
      const res = await POST(
        req({}, { headers: { "content-length": String(7 * MIB) } }),
      );
      expect(res.status).toBe(413);
      expect((await res.json()).error).toBe("body_too_large");
      expect(parsedLargeText(parse)).toBe(false);
      expect(getDaemonTokenContext).not.toHaveBeenCalled();
      parse.mockRestore();
    });

    it("413 on a body that streams past the cap with a lying content-length", async () => {
      await openStep();
      const parse = vi.spyOn(JSON, "parse");
      const chunk = new Uint8Array(MIB).fill(97);
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent++ >= 8) return controller.close();
          controller.enqueue(chunk);
        },
      });
      const res = await POST(
        req(null, { raw: stream, headers: { "content-length": "10" } }),
      );
      expect(res.status).toBe(413);
      expect(parsedLargeText(parse)).toBe(false);
      parse.mockRestore();
    });

    it("413 on a body past the cap with no content-length", async () => {
      await openStep();
      const res = await POST(req(null, { raw: "x".repeat(7 * MIB) }));
      expect(res.status).toBe(413);
      expect(store.puts).toBe(0);
    });
  });

  describe("auth and F5: the cell's own step only", () => {
    it("401 without a token context; 403 for a non-daemon token", async () => {
      vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(null);
      expect((await POST(req({}))).status).toBe(401);
      vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(
        ctx({ tokenType: null }),
      );
      expect((await POST(req({}))).status).toBe(403);
    });

    it.each([
      ["threadId", { threadId: null }],
      ["threadChatId", { threadChatId: null }],
    ])("403 binding_required for a null %s binding", async (_name, over) => {
      await openStep();
      vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(
        ctx(over as Partial<DaemonTokenContext>),
      );
      const res = await POST(
        req({ ...ids(), action: "read-blob", sha256: "0".repeat(64) }),
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("binding_required");
      expect(store.puts).toBe(0);
    });

    async function putBlobBody() {
      const bytes = Buffer.from("x");
      return {
        ...base(),
        action: "put-blob",
        sha256: sha256Hex(bytes),
        base64: bytes.toString("base64"),
      };
    }

    it("403 no_open_cell_step for a box run's token (no cell step), and nothing is written", async () => {
      const res = await POST(req(await putBlobBody()));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("no_open_cell_step");
      expect(store.puts).toBe(0);
    });

    it("403 for a retired attempt, a revoked attempt, and another thread's step", async () => {
      await openStep();
      const second = await openStep(); // fences attempt 1
      expect(second).toBe(2);
      const older = await POST(req({ ...(await putBlobBody()), attempt: 1 }));
      expect(older.status).toBe(403);

      await revokeAttempt({ db, stepKey: cellStepKey(apiKeyId), attempt: 2 });
      const revoked = await POST(req({ ...(await putBlobBody()), attempt: 2 }));
      expect(revoked.status).toBe(403);
      expect((await revoked.json()).error).toBe("no_open_cell_step");

      const other = await createTestThread({
        db,
        userId,
        overrides: { organizationId: orgId },
      });
      const otherKey = `apikey_${nanoid(10)}`;
      await openStep(otherKey, other.threadId);
      vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(
        ctx({ apiKeyId: otherKey }),
      );
      const foreign = await POST(req(await putBlobBody()));
      expect(foreign.status).toBe(403);
      expect(store.puts).toBe(0);
    });

    it("409 superseded for a stale runExternalId", async () => {
      await openStep();
      await db
        .update(threadTable)
        .set({ activeRunExternalId: "run-live" })
        .where(and(eq(threadTable.id, threadId)));
      const res = await POST(req(await putBlobBody()));
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("superseded");
      expect(store.puts).toBe(0);
    });
  });

  describe("the write", () => {
    it("200 written: put-blob, commit, read-head, read-blob; 400 on a hash mismatch", async () => {
      await openStep();
      const bytes = Buffer.from("turn one\n");
      const sha = sha256Hex(bytes);
      const put = await POST(
        req({
          ...base(),
          action: "put-blob",
          sha256: sha,
          base64: bytes.toString("base64"),
        }),
      );
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({ created: true });

      const bad = await POST(
        req({
          ...base(),
          action: "put-blob",
          sha256: "a".repeat(64),
          base64: bytes.toString("base64"),
        }),
      );
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toBe("hash_mismatch");

      const m = manifest();
      const commit = await POST(
        req({ ...base(), action: "commit", manifest: m, expectedVersion: 0 }),
      );
      expect(commit.status).toBe(200);
      expect(await commit.json()).toEqual({ version: 1 });

      const head = await POST(
        req({ ...base(), action: "read-head", sessionId: SESSION }),
      );
      const headBody = await head.json();
      expect(headBody.found).toBe(true);
      expect(headBody.version).toBe(1);
      expect(headBody.manifest.id).toBe(m.id);

      const blob = await POST(
        req({ ...ids(), action: "read-blob", sha256: sha }),
      );
      expect(Buffer.from((await blob.json()).base64, "base64")).toEqual(bytes);
      const missing = await POST(
        req({ ...ids(), action: "read-blob", sha256: "b".repeat(64) }),
      );
      expect(missing.status).toBe(404);
    });

    it("400 bad_manifest when the manifest names another run than the fenced one", async () => {
      await openStep();
      const bytes = Buffer.from("turn one\n");
      await POST(
        req({
          ...base(),
          action: "put-blob",
          sha256: sha256Hex(bytes),
          base64: bytes.toString("base64"),
        }),
      );
      const other = manifest({ runExternalId: "run-other" });
      const res = await POST(
        req({
          ...base(),
          action: "commit",
          manifest: other,
          expectedVersion: 0,
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_manifest" });
      const head = await POST(
        req({ ...base(), action: "read-head", sessionId: SESSION }),
      );
      expect((await head.json()).found).toBe(false);
    });

    it("409 head_moved with the current version on a lost CAS, not a store failure", async () => {
      await openStep();
      const bytes = Buffer.from("turn one\n");
      await POST(
        req({
          ...base(),
          action: "put-blob",
          sha256: sha256Hex(bytes),
          base64: bytes.toString("base64"),
        }),
      );
      const m = manifest();
      await POST(
        req({ ...base(), action: "commit", manifest: m, expectedVersion: 0 }),
      );
      const lost = await POST(
        req({ ...base(), action: "commit", manifest: m, expectedVersion: 0 }),
      );
      expect(lost.status).toBe(409);
      expect(await lost.json()).toEqual({ error: "head_moved", version: 1 });
    });

    it("never logs the body or blob bytes", async () => {
      await openStep();
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const secret = Buffer.from("SECRET-TRANSCRIPT-LINE");
      await POST(
        req({
          ...base(),
          action: "put-blob",
          sha256: sha256Hex(secret),
          base64: secret.toString("base64"),
        }),
      );
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).not.toContain("SECRET-TRANSCRIPT-LINE");
      expect(logged).not.toContain(secret.toString("base64"));
      log.mockRestore();
    });
  });
});
