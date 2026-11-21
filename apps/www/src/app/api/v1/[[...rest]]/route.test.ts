import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { checkRepoAdmin } from "@/lib/repo-admin";
import { isRepoInOrganizationScope } from "@/server-lib/user-repos";
import { mintKey, mockSession } from "@/test-helpers/egress-api";
import { eq } from "drizzle-orm";
import {
  repoEgressAuditLog,
  repoReviewSettings,
} from "@terragon/shared/db/schema";
import { upsertRepoReviewSetting } from "@terragon/shared/model/repo-review-settings";
import {
  createTestOrganization,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import {
  POST as cliPOST,
  OPTIONS as cliOPTIONS,
} from "../../cli/[[...slug]]/route";
import { GET, PATCH } from "./route";

vi.mock("@/lib/repo-admin", () => ({ checkRepoAdmin: vi.fn() }));
vi.mock("@/server-lib/user-repos", () => ({
  isRepoInOrganizationScope: vi.fn(),
}));

const ORIGIN = "https://app.example.test";
const EGRESS = "/api/v1/orgs";

function get(path: string, headers: Record<string, string> = {}) {
  return GET(new Request(`${ORIGIN}${path}`, { headers }));
}

function patch(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return PATCH(
    new Request(`${ORIGIN}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/v1 REST mount", () => {
  let userId: string;
  let org: { id: string; slug: string };
  let key: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", ORIGIN);
    vi.mocked(isRepoInOrganizationScope).mockResolvedValue(true);
    vi.mocked(checkRepoAdmin).mockResolvedValue("not-admin");
    userId = (await createTestUser({ db })).user.id;
    org = (await createTestOrganization({ db, userId, name: "Alpha" }))
      .organization;
    key = await mintKey(userId, org.id);
  });

  it("AC-1: 200 with x-api-version and no CORS header", async () => {
    const res = await get(`${EGRESS}/${org.slug}/repos/acme/widgets/egress`, {
      "X-Daemon-Token": key,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-api-version")).toBe("1");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = await res.json();
    expect(body).toMatchObject({
      repo: "acme/widgets",
      stored: { level: null },
      box: { enforced: false },
      cell: { ok: true },
      canEdit: true,
    });
  });

  it("serves the stored row, with the Bearer form", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: org.id,
      repoFullName: "acme/widgets",
      patch: { egressPolicy: "domain", egressAllowlist: ["a.example.org"] },
    });
    const res = await get(`${EGRESS}/${org.id}/repos/acme/widgets/egress`, {
      Authorization: `Bearer ${key}`,
    });
    const body = await res.json();
    expect(body.stored.allowlist).toEqual(["a.example.org"]);
  });

  it("AC-3: org_mismatch is oRPC's envelope on REST, and no key means 401", async () => {
    const other = (await createTestOrganization({ db, userId, name: "Beta" }))
      .organization;
    const res = await get(`${EGRESS}/${other.id}/repos/acme/widgets/egress`, {
      "X-Daemon-Token": key,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      defined: true,
      code: "FORBIDDEN",
      status: 403,
      data: { reason: "org_mismatch" },
    });
    expect(res.headers.get("x-api-version")).toBe("1");
    const anon = await get(`${EGRESS}/${org.id}/repos/acme/widgets/egress`);
    expect(anon.status).toBe(401);
  });

  it("a session works on this mount, and a Bearer is never read as a session", async () => {
    const getSession = mockSession(userId);
    const ok = await get(`${EGRESS}/${org.id}/repos/acme/widgets/egress`);
    expect(ok.status).toBe(200);
    getSession.mockClear();
    const bogus = await get(`${EGRESS}/${org.id}/repos/acme/widgets/egress`, {
      Authorization: "Bearer bogus",
    });
    expect(bogus.status).toBe(401);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("maps an input the schema refuses to the declared invalid_input", async () => {
    const badLimit = await get(
      `${EGRESS}/${org.id}/repos/acme/widgets/egress/history?limit=0`,
      { "X-Daemon-Token": key },
    );
    expect(badLimit.status).toBe(400);
    expect(await badLimit.json()).toMatchObject({
      code: "BAD_REQUEST",
      data: { errors: [{ code: "invalid_input", entry: null, index: null }] },
    });
    const badRepo = await get(
      `${EGRESS}/${org.id}/repos/acme/wid%20gets/egress`,
      {
        "X-Daemon-Token": key,
      },
    );
    expect(badRepo.status).toBe(400);
  });

  it("not-found parity: the same status, headers and body bytes for every not-in-org cause", async () => {
    vi.mocked(isRepoInOrganizationScope).mockResolvedValue(false);
    const other = (await createTestOrganization({ db, userId, name: "Beta" }))
      .organization;
    // A row only in ANOTHER org for the same repo.
    await upsertRepoReviewSetting({
      db,
      organizationId: other.id,
      repoFullName: "acme/widgets",
      patch: { egressPolicy: "none" },
    });
    const snapshot = async (path: string) => {
      const res = await get(path, { "X-Daemon-Token": key });
      const headers = [...res.headers.entries()].filter(
        ([name]) => name !== "date",
      );
      return { status: res.status, headers, body: await res.text() };
    };
    const rowElsewhere = await snapshot(
      `${EGRESS}/${org.id}/repos/acme/widgets/egress`,
    );
    const absent = await snapshot(
      `${EGRESS}/${org.id}/repos/acme/nothing/egress`,
    );
    const historyAbsent = await snapshot(
      `${EGRESS}/${org.id}/repos/acme/nothing/egress/history`,
    );
    expect(rowElsewhere.status).toBe(404);
    expect(absent).toEqual(rowElsewhere);
    expect(historyAbsent).toEqual(rowElsewhere);
  });

  it("lists exactly the four egress operations in openapi.json", async () => {
    const res = await get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-api-version")).toBe("1");
    const doc = await res.json();
    // The contract's paths start at /v1; the mount serves them under /api.
    expect(doc.servers).toEqual([{ url: "/api" }]);
    const operations = Object.entries(
      doc.paths as Record<string, Record<string, unknown>>,
    )
      .flatMap(([path, methods]) =>
        Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`),
      )
      .sort();
    expect(operations).toEqual([
      "GET /v1/orgs/{org}/egress",
      "GET /v1/orgs/{org}/repos/{owner}/{repo}/egress",
      "GET /v1/orgs/{org}/repos/{owner}/{repo}/egress/history",
      "PATCH /v1/orgs/{org}/repos/{owner}/{repo}/egress",
    ]);
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual([
      "apiKey",
      "bearer",
    ]);
    expect(JSON.stringify(doc)).not.toContain("threads");
  });

  it("answers an unknown path with 404 and the version header", async () => {
    const res = await get("/api/v1/nothing");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-api-version")).toBe("1");
  });
});

describe("/api/cli RPC mount, egress", () => {
  it("serves egress.get with the same key, announces the version, ignores cookies", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", ORIGIN);
    vi.restoreAllMocks();
    vi.mocked(isRepoInOrganizationScope).mockResolvedValue(true);
    vi.mocked(checkRepoAdmin).mockResolvedValue("admin");
    const userId = (await createTestUser({ db })).user.id;
    const { organization } = await createTestOrganization({ db, userId });
    const key = await mintKey(userId, organization.id);
    const call = (headers: Record<string, string>) =>
      cliPOST(
        new Request(`${ORIGIN}/api/cli/egress/get`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({
            json: { org: organization.id, owner: "acme", repo: "widgets" },
          }),
        }),
      );
    const res = await call({ "X-Daemon-Token": key });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-api-version")).toBe("1");
    expect((await res.json()).json).toMatchObject({ repo: "acme/widgets" });

    // A cookie never authenticates this mount (it sends a wildcard CORS header).
    const getSession = mockSession(userId);
    const cookieOnly = await call({ cookie: "better-auth.session_token=x" });
    expect(cookieOnly.status).toBe(401);
    expect(getSession).not.toHaveBeenCalled();
    expect((await cliOPTIONS()).headers.get("x-api-version")).toBe("1");
  });
});

describe("/api/v1 REST mount: PATCH egress", () => {
  let userId: string;
  let org: { id: string; slug: string };
  let key: string;
  const path = (o: string) => `${EGRESS}/${o}/repos/acme/widgets/egress`;

  const rows = async () =>
    (
      await db
        .select()
        .from(repoReviewSettings)
        .where(eq(repoReviewSettings.organizationId, org.id))
    ).length;
  const audits = async () =>
    (
      await db
        .select()
        .from(repoEgressAuditLog)
        .where(eq(repoEgressAuditLog.organizationId, org.id))
    ).length;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", ORIGIN);
    vi.mocked(isRepoInOrganizationScope).mockResolvedValue(true);
    vi.mocked(checkRepoAdmin).mockResolvedValue("not-admin");
    userId = (await createTestUser({ db })).user.id;
    org = (await createTestOrganization({ db, userId, name: "Alpha" }))
      .organization;
    key = await mintKey(userId, org.id);
  });

  it("applies a change with a key, and announces the version", async () => {
    const res = await patch(
      path(org.slug),
      { level: "domain", add: ["a.example.org"] },
      { "X-Daemon-Token": key },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-api-version")).toBe("1");
    expect(await res.json()).toMatchObject({
      applied: true,
      after: { stored: { level: "domain", allowlist: ["a.example.org"] } },
    });
    expect(await audits()).toBe(1);
  });

  it("AC-6 over REST: 400 with the declared envelope and every error; nothing written", async () => {
    const res = await patch(
      path(org.id),
      { level: "domain", add: ["*.example.com", "10.0.0.1"] },
      { Authorization: `Bearer ${key}` },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({
      defined: true,
      code: "BAD_REQUEST",
      status: 400,
    });
    expect(body.data.errors.map((e: { code: string }) => e.code)).toEqual([
      "wildcard_not_allowed",
      "ip_not_allowed",
    ]);
    expect(await rows()).toBe(0);
    expect(await audits()).toBe(0);
  });

  it("a body the schema refuses (201 hosts) is the declared invalid_input, not an undeclared error", async () => {
    const add = Array.from({ length: 201 }, (_, i) => `h${i}.example.org`);
    const res = await patch(path(org.id), { add }, { "X-Daemon-Token": key });
    expect(res.status).toBe(400);
    expect((await res.json()).data.errors[0]).toMatchObject({
      code: "invalid_input",
    });
    expect(await rows()).toBe(0);
  });

  it("101 hosts reach the classifier: too_many_entries", async () => {
    const add = Array.from({ length: 101 }, (_, i) => `h${i}.example.org`);
    const res = await patch(
      path(org.id),
      { level: "domain", add },
      { "X-Daemon-Token": key },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).data.errors[0]).toMatchObject({
      code: "too_many_entries",
    });
  });

  it("a session write without this app's Origin is 403 origin_mismatch, and with it succeeds", async () => {
    mockSession(userId);
    const denied = await patch(path(org.id), { level: "domain" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      code: "FORBIDDEN",
      data: { reason: "origin_mismatch" },
    });
    expect(await rows()).toBe(0);
    const ok = await patch(
      path(org.id),
      { level: "domain" },
      { Origin: ORIGIN },
    );
    expect(ok.status).toBe(200);
    expect(await rows()).toBe(1);
  });

  it("/api/cli stays token-only: a session never writes there", async () => {
    mockSession(userId);
    const res = await cliPOST(
      new Request(`${ORIGIN}/api/cli/egress/update`, {
        method: "POST",
        headers: { "content-type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({
          json: {
            org: org.id,
            owner: "acme",
            repo: "widgets",
            level: "domain",
          },
        }),
      }),
    );
    expect(res.status).toBe(401);
    expect(await rows()).toBe(0);
  });
});
