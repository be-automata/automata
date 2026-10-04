import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  hashSelfHealToken,
  mintSelfHealToken,
} from "@/server-lib/audit/plan-self-heal-run";
import { auditRuns, thread } from "@terragon/shared/db/schema";
import { createAuditRunAtDispatch } from "@terragon/shared/model/audit-findings";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { POST } from "./route";

const REPO = "acme/widgets";
const FP_A = "aaaaaaaaaaaaaaaa";
const FP_B = "bbbbbbbbbbbbbbbb";
const FP_C = "cccccccccccccccc";

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/self-heal/audit-checks", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("POST /api/self-heal/audit-checks", () => {
  let orgId: string;
  let threadId: string;
  let token: string;

  const seedRun = async (expiresAt?: Date) => {
    token = mintSelfHealToken();
    await createAuditRunAtDispatch({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      threadId,
      audit: "security-audit",
      requestedChecks: [
        { fingerprint: FP_A, check: "file-exists", subject: "a" },
        { fingerprint: FP_B, check: "file-exists", subject: "b" },
      ],
      checkTokenHash: hashSelfHealToken(token),
      checkTokenExpiresAt: expiresAt ?? new Date(Date.now() + 60_000),
    });
  };

  const stored = async () => {
    const [row] = await db
      .select()
      .from(auditRuns)
      .where(eq(auditRuns.threadId, threadId));
    return row?.checkResults ?? null;
  };

  const post = (body: unknown, tokenValue: string | null = token) =>
    POST(
      req(
        body,
        tokenValue === null ? {} : { "x-self-heal-check-token": tokenValue },
      ),
    );

  beforeEach(async () => {
    vi.restoreAllMocks();
    const user = (await createTestUser({ db })).user;
    orgId = (
      await createOrganization({
        db,
        name: "Org",
        slug: `org-${nanoid(8).toLowerCase()}`,
      })
    ).id;
    threadId = (
      await createTestThread({
        db,
        userId: user.id,
        overrides: { organizationId: orgId },
      })
    ).threadId;
    await seedRun();
  });

  it("rejects a missing, wrong, or different-length token with an identical 401", async () => {
    const body = {
      threadId,
      results: [{ fingerprint: FP_A, outcome: "pass" }],
    };
    const bodies: unknown[] = [];
    for (const t of [null, "wrong", mintSelfHealToken()]) {
      const res = await post(body, t);
      expect(res.status).toBe(401);
      bodies.push(await res.json());
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(await stored()).toBeNull();
  });

  it("rejects an expired token", async () => {
    await db.delete(auditRuns).where(eq(auditRuns.threadId, threadId));
    await seedRun(new Date(Date.now() - 1000));
    const res = await post({ threadId, results: [] });
    expect(res.status).toBe(401);
    expect(await stored()).toBeNull();
  });

  it("does not accept a daemon token", async () => {
    const res = await POST(
      req({ threadId, results: [] }, { "X-Daemon-Token": "some-daemon-token" }),
    );
    expect(res.status).toBe(401);
  });

  it("400s on a malformed body without writing", async () => {
    const bad: unknown[] = [
      { threadId, results: [{ fingerprint: "XYZ", outcome: "pass" }] },
      { threadId, results: [{ fingerprint: FP_A, outcome: "maybe" }] },
      {
        threadId,
        results: Array.from({ length: 51 }, () => ({
          fingerprint: FP_A,
          outcome: "pass",
        })),
      },
      { threadId: "not-a-uuid", results: [] },
      "{not json",
    ];
    for (const body of bad) {
      expect((await post(body)).status).toBe(400);
    }
    expect(await stored()).toBeNull();
  });

  it("404s for a thread with no audit run", async () => {
    const user = (await createTestUser({ db })).user;
    const other = (await createTestThread({ db, userId: user.id })).threadId;
    const res = await post({ threadId: other, results: [] });
    expect(res.status).toBe(404);
  });

  it("409 sealed once the thread holds an agent message, with no write", async () => {
    await db
      .update(thread)
      .set({
        messages: [{ type: "agent", parent_tool_use_id: null, parts: [] }],
      })
      .where(eq(thread.id, threadId));
    const res = await post({
      threadId,
      results: [{ fingerprint: FP_A, outcome: "pass" }],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "sealed" });
    expect(await stored()).toBeNull();
  });

  it("records a valid report, ignores unrequested fingerprints and seals missing ones as error", async () => {
    const res = await post({
      threadId,
      results: [
        { fingerprint: FP_A, outcome: "pass" },
        { fingerprint: FP_C, outcome: "pass" },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      recorded: true,
      ignored: 1,
      sealedAsError: 1,
    });
    const results = (await stored()) as {
      fingerprint: string;
      outcome: string;
    }[];
    expect(results).toHaveLength(2);
    expect(results).toEqual(
      expect.arrayContaining([
        { fingerprint: FP_A, outcome: "pass" },
        { fingerprint: FP_B, outcome: "error" },
      ]),
    );
  });

  it("accepts only the first report; the second changes nothing", async () => {
    await post({ threadId, results: [{ fingerprint: FP_A, outcome: "fail" }] });
    const before = await stored();
    const res = await post({
      threadId,
      results: [
        { fingerprint: FP_A, outcome: "pass" },
        { fingerprint: FP_B, outcome: "pass" },
      ],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).recorded).toBe(false);
    expect(await stored()).toEqual(before);
  });

  it("never logs the token", async () => {
    const spies = (["log", "warn", "error", "info"] as const).map((level) =>
      vi.spyOn(console, level),
    );
    await post({ threadId, results: [{ fingerprint: FP_A, outcome: "pass" }] });
    await post({ threadId, results: [] }, "wrong");
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(token);
      }
    }
  });
});
