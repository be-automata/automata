import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { thread } from "@terragon/shared/db/schema";
import {
  markStepDone,
  mintBearer,
  openStep,
  revokeAttempt,
  type Refusal,
} from "@terragon/shared/model/cell-authority";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import {
  assertOrigin,
  brokerError,
  cellBrokerEnabled,
  decodePathSegments,
  extractCellBearer,
  forwardRequestHeaders,
  gitAuthChallenge,
  isUnsafeSegment,
  notFound,
  refusalResponse,
  resolveCellStep,
  responseHeadersForCell,
} from "./common";

const basic = (user: string, pass: string) =>
  `Basic ${btoa(`${user}:${pass}`)}`;
const withAuth = (value: string) => new Headers({ authorization: value });

describe("cellBrokerEnabled / notFound", () => {
  const original = env.CELL_BROKER_ENABLED;
  afterEach(() => {
    (env as { CELL_BROKER_ENABLED: boolean }).CELL_BROKER_ENABLED = original;
  });

  it("follows CELL_BROKER_ENABLED (default false)", () => {
    expect(original).toBe(false);
    (env as { CELL_BROKER_ENABLED: boolean }).CELL_BROKER_ENABLED = true;
    expect(cellBrokerEnabled()).toBe(true);
  });

  it("notFound is a 404 JSON not_found", async () => {
    const res = notFound();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("extractCellBearer", () => {
  it("reads Bearer, token (gh) and Basic password (git), scheme case-insensitive", () => {
    expect(extractCellBearer(withAuth("Bearer abc"))).toBe("abc");
    expect(extractCellBearer(withAuth("BEARER abc"))).toBe("abc");
    expect(extractCellBearer(withAuth("token abc"))).toBe("abc");
    expect(extractCellBearer(withAuth(basic("x-access-token", "abc")))).toBe(
      "abc",
    );
    expect(extractCellBearer(withAuth(basic("", "abc")))).toBe("abc");
  });

  it("is null when absent, empty, malformed or of another scheme", () => {
    expect(extractCellBearer(new Headers())).toBeNull();
    expect(extractCellBearer(withAuth("Bearer "))).toBeNull();
    expect(extractCellBearer(withAuth("Bearer"))).toBeNull();
    expect(extractCellBearer(withAuth("Digest abc"))).toBeNull();
    expect(extractCellBearer(withAuth(basic("user", "")))).toBeNull();
    expect(extractCellBearer(withAuth("Basic !!!notbase64"))).toBeNull();
    expect(extractCellBearer(withAuth(`Basic ${btoa("nocolon")}`))).toBeNull();
  });
});

describe("responses", () => {
  it("gitAuthChallenge is a 401 with a Basic challenge", async () => {
    const res = gitAuthChallenge();
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Basic realm="automata-cell"',
    );
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it.each<[Refusal, number]>([
    ["unknown_bearer", 401],
    ["expired", 401],
    ["revoked", 401],
    ["fenced", 409],
    ["step_done", 409],
    ["effect_in_progress", 409],
    ["effect_budget_exhausted", 429],
  ])("refusal %s answers %i with the reason as the body", async (r, status) => {
    const res = refusalResponse(r);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: r });
  });

  it("brokerError carries a status and a code", async () => {
    const res = brokerError(403, "forbidden_path");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_path" });
  });
});

describe("decodePathSegments", () => {
  const PREFIX = "/api/cell/git";

  it("strips the prefix, decodes each segment and drops a trailing empty one", () => {
    expect(
      decodePathSegments(`${PREFIX}/acme/widgets.git/info/refs/`, PREFIX),
    ).toEqual({
      ok: true,
      segments: ["acme", "widgets.git", "info", "refs"],
    });
    expect(decodePathSegments(`${PREFIX}/a/feat%2Fx`, PREFIX)).toEqual({
      ok: true,
      segments: ["a", "feat/x"],
    });
    expect(decodePathSegments(PREFIX, PREFIX)).toEqual({
      ok: true,
      segments: [],
    });
  });

  it("is not ok for a bad escape or a different prefix", () => {
    expect(decodePathSegments(`${PREFIX}/a/%E0%A4%A`, PREFIX)).toEqual({
      ok: false,
    });
    expect(decodePathSegments("/api/other/a", PREFIX)).toEqual({ ok: false });
    expect(decodePathSegments(`${PREFIX}x/a`, PREFIX)).toEqual({ ok: false });
  });
});

describe("isUnsafeSegment", () => {
  it("refuses dot segments, backslash and control characters in both modes", () => {
    for (const mode of ["git", "gh"] as const) {
      expect(isUnsafeSegment(".", mode)).toBe(true);
      expect(isUnsafeSegment("..", mode)).toBe(true);
      expect(isUnsafeSegment("a\\b", mode)).toBe(true);
      expect(isUnsafeSegment("a\u0000b", mode)).toBe(true);
      expect(isUnsafeSegment("a\nb", mode)).toBe(true);
      expect(isUnsafeSegment("a\u007fb", mode)).toBe(true);
    }
  });

  it("git also refuses empty, slash and percent; gh allows them", () => {
    expect(isUnsafeSegment("", "git")).toBe(true);
    expect(isUnsafeSegment("a/b", "git")).toBe(true);
    expect(isUnsafeSegment("a%b", "git")).toBe(true);
    expect(isUnsafeSegment("feat/x", "gh")).toBe(false);
    expect(isUnsafeSegment("100%", "gh")).toBe(false);
  });

  it("allows ordinary names with dots", () => {
    expect(isUnsafeSegment("next.js", "git")).toBe(false);
    expect(isUnsafeSegment("main...feat", "gh")).toBe(false);
  });

  it("refuses a %2e%2e segment once decoded", () => {
    const decoded = decodePathSegments("/p/%2e%2e", "/p");
    expect(decoded).toEqual({ ok: true, segments: [".."] });
    if (decoded.ok) {
      expect(isUnsafeSegment(decoded.segments[0] ?? "", "git")).toBe(true);
      expect(isUnsafeSegment(decoded.segments[0] ?? "", "gh")).toBe(true);
    }
  });
});

describe("forwardRequestHeaders", () => {
  it("strips owned, hop-by-hop, edge and cookie headers; keeps git's and content-encoding", () => {
    const out = forwardRequestHeaders(
      new Headers({
        authorization: "Bearer secret",
        host: "www.example.com",
        connection: "keep-alive",
        "content-length": "10",
        "transfer-encoding": "chunked",
        cookie: "a=b",
        expect: "100-continue",
        te: "trailers",
        "proxy-authorization": "x",
        "x-real-ip": "1.2.3.4",
        "true-client-ip": "1.2.3.4",
        "cf-ray": "abc",
        "cf-connecting-ip": "1.2.3.4",
        "x-forwarded-for": "1.2.3.4",
        "x-forwarded-proto": "https",
        "content-encoding": "gzip",
        "content-type": "application/x-git-upload-pack-request",
        "git-protocol": "version=2",
        "user-agent": "git/2.45",
        accept: "*/*",
      }),
    );
    expect([...out.keys()].sort()).toEqual([
      "accept",
      "content-encoding",
      "content-type",
      "git-protocol",
      "user-agent",
    ]);
    expect(out.get("content-encoding")).toBe("gzip");
  });
});

describe("responseHeadersForCell", () => {
  const upstream = () => {
    const h = new Headers({
      "content-type": "application/json",
      "content-length": "5",
      "content-encoding": "gzip",
      "transfer-encoding": "chunked",
      connection: "close",
      "access-control-allow-origin": "*",
      "x-ratelimit-remaining": "42",
      link: '<https://api.github.com/repos/a/b/issues?page=2>; rel="next", <https://api.github.com/repos/a/b/issues?page=5>; rel="last"',
    });
    h.append("set-cookie", "a=b");
    h.append("set-cookie", "c=d");
    return h;
  };

  it("drops cookies and framing headers and keeps the rest", () => {
    const out = responseHeadersForCell(upstream());
    expect(out.has("set-cookie")).toBe(false);
    for (const name of [
      "content-length",
      "content-encoding",
      "transfer-encoding",
      "connection",
    ]) {
      expect(out.has(name)).toBe(false);
    }
    expect(out.get("content-type")).toBe("application/json");
    expect(out.get("x-ratelimit-remaining")).toBe("42");
    expect(out.get("link")).toContain("https://api.github.com/repos/a/b");
  });

  it("rewrites Link URLs onto the broker host when asked", () => {
    const out = responseHeadersForCell(upstream(), {
      rewriteLinkHost: "www.example.com",
    });
    expect(out.get("link")).toBe(
      '<https://www.example.com/api/v3/repos/a/b/issues?page=2>; rel="next", <https://www.example.com/api/v3/repos/a/b/issues?page=5>; rel="last"',
    );
  });
});

describe("assertOrigin", () => {
  it("passes the fixed origin and throws on any other", () => {
    expect(() =>
      assertOrigin(new URL("https://github.com/a/b.git"), "https://github.com"),
    ).not.toThrow();
    expect(() =>
      assertOrigin(
        new URL("https://github.com.evil.test/a"),
        "https://github.com",
      ),
    ).toThrow(/origin/);
    expect(() =>
      assertOrigin(
        new URL("http://api.github.com/user"),
        "https://api.github.com",
      ),
    ).toThrow(/origin/);
  });
});

describe("resolveCellStep (database)", () => {
  const STEP_TIMEOUT = 30 * 60_000;

  async function fixture(repo = "Acme/Widgets") {
    const organizationId = await createTestOrg({ db });
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { githubRepoFullName: repo },
    });
    await db
      .update(thread)
      .set({ organizationId })
      .where(eq(thread.id, threadId));
    const stepKey = `run-${randomUUID()}/agent`;
    const open = (attempt: number, orgId = organizationId) =>
      openStep({
        db,
        step: {
          stepKey,
          organizationId: orgId,
          threadId,
          attempt,
          stepTimeoutMs: STEP_TIMEOUT,
          effectBudget: null,
        },
      });
    const bearer = async (attempt: number, ttlMs = STEP_TIMEOUT) => {
      const m = await mintBearer({ db, stepKey, attempt, ttlMs });
      if (!m.ok) throw new Error(m.reason);
      return m.token;
    };
    return { organizationId, threadId, stepKey, open, bearer };
  }

  it("a valid bearer resolves to its context and the normalized repo", async () => {
    const f = await fixture();
    await f.open(1);
    const result = await resolveCellStep(db, await f.bearer(1));
    expect(result).toEqual({
      ok: true,
      context: {
        stepKey: f.stepKey,
        attempt: 1,
        organizationId: f.organizationId,
        threadId: f.threadId,
      },
      repoFullName: "acme/widgets",
    });
  });

  it("maps revoked, expired, fenced, step_done and unknown bearers to their refusal", async () => {
    const revoked = await fixture();
    await revoked.open(1);
    const revokedToken = await revoked.bearer(1);
    await revokeAttempt({ db, stepKey: revoked.stepKey, attempt: 1 });
    expect(await resolveCellStep(db, revokedToken)).toEqual({
      ok: false,
      reason: "revoked",
    });

    const expired = await fixture();
    await expired.open(1);
    const expiredToken = await expired.bearer(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await resolveCellStep(db, expiredToken)).toEqual({
      ok: false,
      reason: "expired",
    });

    const fenced = await fixture();
    await fenced.open(1);
    const fencedToken = await fenced.bearer(1);
    await fenced.open(2);
    expect(await resolveCellStep(db, fencedToken)).toEqual({
      ok: false,
      reason: "fenced",
    });

    const done = await fixture();
    await done.open(1);
    const doneToken = await done.bearer(1);
    await markStepDone({ db, token: doneToken });
    expect(await resolveCellStep(db, doneToken)).toEqual({
      ok: false,
      reason: "step_done",
    });

    expect(await resolveCellStep(db, "not-a-bearer")).toEqual({
      ok: false,
      reason: "unknown_bearer",
    });
  });

  it("a thread of another organization reads as an unknown bearer", async () => {
    const f = await fixture();
    await f.open(1);
    const token = await f.bearer(1);
    const otherOrg = await createTestOrg({ db });
    await db
      .update(thread)
      .set({ organizationId: otherOrg })
      .where(eq(thread.id, f.threadId));
    expect(await resolveCellStep(db, token)).toEqual({
      ok: false,
      reason: "unknown_bearer",
    });
  });
});
