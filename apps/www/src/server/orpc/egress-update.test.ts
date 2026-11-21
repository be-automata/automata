import { createRouterClient, ORPCError } from "@orpc/server";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { getPostHogServer } from "@/lib/posthog-server";
import { checkCliEgressWriteRateLimit } from "@/lib/rate-limit";
import { checkRepoAdmin } from "@/lib/repo-admin";
import { isRepoInOrganizationScope } from "@/server-lib/user-repos";
import { mintKey, mockSession, rejection } from "@/test-helpers/egress-api";
import {
  repoEgressAuditLog,
  repoReviewSettings,
} from "@terragon/shared/db/schema";
import { recordRepoEgressChange } from "@terragon/shared/model/repo-egress-audit-log";
import {
  getRepoReviewSetting,
  upsertRepoReviewSetting,
} from "@terragon/shared/model/repo-review-settings";
import {
  createTestOrganization,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { egressRouter } from "./egress-router";

vi.mock("@/lib/repo-admin", () => ({ checkRepoAdmin: vi.fn() }));
vi.mock("@/server-lib/user-repos", () => ({
  isRepoInOrganizationScope: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkCliEgressWriteRateLimit: vi.fn(),
}));
vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: vi.fn(),
}));
// Pass-through wrappers, so a test can fail the audit insert or race a legacy write.
vi.mock("@terragon/shared/model/repo-egress-audit-log", async (original) => {
  const actual =
    await original<
      typeof import("@terragon/shared/model/repo-egress-audit-log")
    >();
  return { ...actual, recordRepoEgressChange: vi.fn() };
});
vi.mock("@terragon/shared/model/repo-review-settings", async (original) => {
  const actual =
    await original<
      typeof import("@terragon/shared/model/repo-review-settings")
    >();
  return { ...actual, upsertRepoReviewSetting: vi.fn() };
});

const REPO = "acme/widgets";
const PATH = { owner: "acme", repo: "widgets" };
const APP = "https://app.example.test";

function clientFor(headers: Headers, allowSession = false) {
  return createRouterClient(
    { egress: egressRouter },
    { context: { headers, allowSession } },
  );
}

const tokenClient = (key: string) =>
  clientFor(new Headers({ "X-Daemon-Token": key }));

async function failure(promise: Promise<unknown>) {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(ORPCError);
  const e = error as ORPCError<string, unknown>;
  return { code: e.code, status: e.status, data: e.data };
}

const rowJson = async (organizationId: string) =>
  JSON.stringify(
    await getRepoReviewSetting({ db, organizationId, repoFullName: REPO }),
  );

describe("egress.update", () => {
  let userId: string;
  let orgA: { id: string; slug: string };
  let orgB: { id: string; slug: string };
  let keyA: string;
  let capture: ReturnType<typeof vi.fn>;
  let actualUpsert: typeof upsertRepoReviewSetting;

  // Counted per test org: the test database is shared by the whole file.
  const rowCount = async () =>
    (
      await db
        .select()
        .from(repoReviewSettings)
        .where(inArray(repoReviewSettings.organizationId, [orgA.id, orgB.id]))
    ).length;
  const auditCount = async () =>
    (
      await db
        .select()
        .from(repoEgressAuditLog)
        .where(inArray(repoEgressAuditLog.organizationId, [orgA.id, orgB.id]))
    ).length;

  const seed = (
    organizationId: string,
    patch: Parameters<typeof upsertRepoReviewSetting>[0]["patch"],
  ) => actualUpsert({ db, organizationId, repoFullName: REPO, patch });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
    vi.mocked(isRepoInOrganizationScope).mockResolvedValue(true);
    vi.mocked(checkRepoAdmin).mockResolvedValue("not-admin");
    vi.mocked(checkCliEgressWriteRateLimit).mockResolvedValue(true);
    capture = vi.fn();
    vi.mocked(getPostHogServer).mockReturnValue({ capture } as never);
    const audit = await vi.importActual<
      typeof import("@terragon/shared/model/repo-egress-audit-log")
    >("@terragon/shared/model/repo-egress-audit-log");
    vi.mocked(recordRepoEgressChange).mockImplementation(
      audit.recordRepoEgressChange,
    );
    const settings = await vi.importActual<
      typeof import("@terragon/shared/model/repo-review-settings")
    >("@terragon/shared/model/repo-review-settings");
    actualUpsert = settings.upsertRepoReviewSetting;
    vi.mocked(upsertRepoReviewSetting).mockImplementation(actualUpsert);
    userId = (await createTestUser({ db })).user.id;
    orgA = (await createTestOrganization({ db, userId, name: "Alpha" }))
      .organization;
    orgB = (await createTestOrganization({ db, userId, name: "Beta" }))
      .organization;
    keyA = await mintKey(userId, orgA.id);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("AC-2: edits org A's row and leaves org B's row for the same repo byte-identical", async () => {
    await seed(orgA.id, {
      egressPolicy: "domain",
      egressAllowlist: ["a.example.org"],
    });
    await seed(orgB.id, {
      egressPolicy: "domain",
      egressAllowlist: ["b.example.org"],
    });
    const bBefore = await rowJson(orgB.id);
    const result = await tokenClient(keyA).egress.update({
      org: orgA.id,
      ...PATH,
      add: ["new.example.org"],
    });
    expect(result.applied).toBe(true);
    expect(result.after.stored.allowlist).toEqual([
      "a.example.org",
      "new.example.org",
    ]);
    expect(result.before.stored.allowlist).toEqual(["a.example.org"]);
    expect(await rowJson(orgB.id)).toBe(bBefore);
    const written = await getRepoReviewSetting({
      db,
      organizationId: orgA.id,
      repoFullName: REPO,
    });
    expect(written?.organizationId).toBe(orgA.id);
    expect(written?.updatedByUserId).toBe(userId);
  });

  it("AC-3: a key for B naming A is refused with org_mismatch and nothing changes; a personal key is org_required", async () => {
    const keyB = await mintKey(userId, orgB.id);
    expect(
      await failure(
        tokenClient(keyB).egress.update({
          org: orgA.id,
          ...PATH,
          level: "domain",
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN", data: { reason: "org_mismatch" } });
    const personal = await mintKey(userId);
    expect(
      await failure(
        tokenClient(personal).egress.update({
          org: orgA.id,
          ...PATH,
          level: "domain",
        }),
      ),
    ).toMatchObject({ data: { reason: "org_required" } });
    expect(await rowCount()).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  it("AC-3: a bogus key is 401 with no write, and the Bearer form writes like X-Daemon-Token", async () => {
    expect(
      await failure(
        tokenClient("bogus").egress.update({
          org: orgA.id,
          ...PATH,
          level: "domain",
        }),
      ),
    ).toMatchObject({ code: "UNAUTHORIZED" });
    expect(await rowCount()).toBe(0);
    const bearer = clientFor(new Headers({ Authorization: `Bearer ${keyA}` }));
    const result = await bearer.egress.update({
      org: orgA.id,
      ...PATH,
      level: "domain",
    });
    expect(result.applied).toBe(true);
  });

  it("AC-4: a session whose active org is B writes org A only, by id and by slug", async () => {
    await seed(orgB.id, {
      egressPolicy: "domain",
      egressAllowlist: ["b.example.org"],
    });
    const bBefore = await rowJson(orgB.id);
    mockSession(userId, { activeOrganizationId: orgB.id });
    const client = clientFor(new Headers({ Origin: APP }), true);
    await client.egress.update({
      org: orgA.slug,
      ...PATH,
      level: "domain",
      add: ["one.example.org"],
    });
    await client.egress.update({
      org: orgA.id,
      ...PATH,
      add: ["two.example.org"],
    });
    const a = await getRepoReviewSetting({
      db,
      organizationId: orgA.id,
      repoFullName: REPO,
    });
    expect(a?.egressAllowlist).toEqual(["one.example.org", "two.example.org"]);
    expect(await rowJson(orgB.id)).toBe(bBefore);
  });

  it("AC-4: a session that is not a member of A is org_forbidden and writes nothing", async () => {
    const stranger = (await createTestUser({ db })).user.id;
    mockSession(stranger, { activeOrganizationId: orgA.id });
    const client = clientFor(new Headers({ Origin: APP }), true);
    expect(
      await failure(
        client.egress.update({ org: orgA.id, ...PATH, level: "domain" }),
      ),
    ).toMatchObject({ code: "FORBIDDEN", data: { reason: "org_forbidden" } });
    expect(await rowCount()).toBe(0);
  });

  it("a session write needs this app's origin: absent or foreign is origin_mismatch (403); a key and a session read are exempt", async () => {
    mockSession(userId);
    for (const headers of [
      new Headers(),
      new Headers({ Origin: "https://evil.example.test" }),
    ]) {
      expect(
        await failure(
          clientFor(headers, true).egress.update({
            org: orgA.id,
            ...PATH,
            level: "domain",
          }),
        ),
      ).toMatchObject({
        code: "FORBIDDEN",
        status: 403,
        data: { reason: "origin_mismatch" },
      });
    }
    expect(await rowCount()).toBe(0);
    await expect(
      clientFor(new Headers(), true).egress.get({ org: orgA.id, ...PATH }),
    ).resolves.toMatchObject({ canEdit: true });
    await expect(
      tokenClient(keyA).egress.update({
        org: orgA.id,
        ...PATH,
        level: "domain",
      }),
    ).resolves.toMatchObject({ applied: true });
  });

  it("AC-5: a non-admin is not_repo_admin, a failed lookup is 503 github_unavailable, dryRun included; no write", async () => {
    const memberId = (await createTestUser({ db })).user.id;
    const member = await createTestOrganization({
      db,
      userId: memberId,
      role: "member",
    });
    const client = tokenClient(await mintKey(memberId, member.organization.id));
    const org = member.organization.id;
    for (const dryRun of [false, true]) {
      expect(
        await failure(
          client.egress.update({ org, ...PATH, level: "domain", dryRun }),
        ),
      ).toMatchObject({
        code: "FORBIDDEN",
        data: { reason: "not_repo_admin" },
      });
    }
    vi.mocked(checkRepoAdmin).mockResolvedValue("lookup-failed");
    for (const dryRun of [false, true]) {
      expect(
        await failure(
          client.egress.update({ org, ...PATH, level: "domain", dryRun }),
        ),
      ).toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        status: 503,
        data: { reason: "github_unavailable" },
      });
    }
    expect(await rowCount()).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  it("AC-6: each refused entry has its own code, index and entry; nothing is written", async () => {
    const cases: [string, string][] = [
      ["*.example.com", "wildcard_not_allowed"],
      ["example.com:8443", "port_not_allowed"],
      ["10.0.0.1", "ip_not_allowed"],
      ["::1", "ipv6_not_allowed"],
      ["exa mple", "invalid_host"],
      ["*.co.uk", "public_suffix_wildcard"],
    ];
    for (const [entry, code] of cases) {
      const error = await failure(
        tokenClient(keyA).egress.update({
          org: orgA.id,
          ...PATH,
          level: "domain",
          add: [entry],
        }),
      );
      expect(error).toMatchObject({ code: "BAD_REQUEST", status: 400 });
      const [first] = (
        error.data as { errors: { code: string; index: number | null }[] }
      ).errors;
      expect(first).toMatchObject({ code, index: 0 });
    }
    const many = Array.from({ length: 101 }, (_, i) => `h${i}.example.org`);
    const tooMany = await failure(
      tokenClient(keyA).egress.update({
        org: orgA.id,
        ...PATH,
        level: "domain",
        add: many,
      }),
    );
    expect(tooMany.data).toMatchObject({
      errors: [{ code: "too_many_entries", entry: null, index: null }],
    });
    const ipPort = await failure(
      tokenClient(keyA).egress.update({
        org: orgA.id,
        ...PATH,
        level: "ip_port",
      }),
    );
    expect(ipPort.data).toMatchObject({
      errors: [{ code: "level_unsupported_in_cell" }],
    });
    expect(await rowCount()).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  it("AC-6: all errors come at once, and a legacy wildcard blocks an add until it is removed", async () => {
    await seed(orgA.id, {
      egressPolicy: "domain",
      egressAllowlist: ["*.legacy.example.com"],
    });
    const client = tokenClient(keyA);
    const refused = await failure(
      client.egress.update({
        org: orgA.id,
        ...PATH,
        add: ["ok.example.org", "10.0.0.1"],
      }),
    );
    const errors = (
      refused.data as { errors: { code: string; index: number }[] }
    ).errors;
    expect(errors.map((e) => [e.code, e.index])).toEqual([
      ["wildcard_not_allowed", 0],
      ["ip_not_allowed", 2],
    ]);
    const fixed = await client.egress.update({
      org: orgA.id,
      ...PATH,
      remove: ["*.legacy.example.com"],
      add: ["ok.example.org"],
    });
    expect(fixed.after.stored.allowlist).toEqual(["ok.example.org"]);
  });

  it("refuses a request-shape rule with invalid_input", async () => {
    const client = tokenClient(keyA);
    const bad: Record<string, unknown>[] = [
      {},
      { allowlist: ["a.example.org"], add: ["b.example.org"] },
      { add: ["a.example.org"], remove: ["A.example.org"] },
    ];
    for (const patch of bad) {
      const error = await failure(
        client.egress.update({ org: orgA.id, ...PATH, ...patch }),
      );
      expect(error).toMatchObject({
        code: "BAD_REQUEST",
        data: { errors: [{ code: "invalid_input", entry: null, index: null }] },
      });
    }
    expect(await rowCount()).toBe(0);
  });

  it("AC-7: two concurrent adds of different hosts both land, with one audit row each", async () => {
    await seed(orgA.id, {
      egressPolicy: "domain",
      egressAllowlist: ["base.example.org"],
    });
    const client = tokenClient(keyA);
    const results = await Promise.all(
      ["x.example.org", "y.example.org"].map((host) =>
        client.egress.update({ org: orgA.id, ...PATH, add: [host] }),
      ),
    );
    expect(results.every((r) => r.applied)).toBe(true);
    const row = await getRepoReviewSetting({
      db,
      organizationId: orgA.id,
      repoFullName: REPO,
    });
    expect([...(row?.egressAllowlist ?? [])].sort()).toEqual([
      "base.example.org",
      "x.example.org",
      "y.example.org",
    ]);
    expect(await auditCount()).toBe(2);
  });

  it("AC-7: concurrent adds to a repo with no row both land too", async () => {
    const client = tokenClient(keyA);
    await Promise.all(
      ["x.example.org", "y.example.org"].map((host) =>
        client.egress.update({
          org: orgA.id,
          ...PATH,
          level: "domain",
          add: [host],
        }),
      ),
    );
    const row = await getRepoReviewSetting({
      db,
      organizationId: orgA.id,
      repoFullName: REPO,
    });
    expect([...(row?.egressAllowlist ?? [])].sort()).toEqual([
      "x.example.org",
      "y.example.org",
    ]);
  });

  it("AC-7: a stale expectedUpdatedAt is CONFLICT with currentUpdatedAt, and so is null while a row exists", async () => {
    const row = await seed(orgA.id, {
      egressPolicy: "domain",
      egressAllowlist: ["a.example.org"],
    });
    const client = tokenClient(keyA);
    const current = row.updatedAt.toISOString();
    for (const expectedUpdatedAt of ["2020-01-01T00:00:00.000Z", null]) {
      expect(
        await failure(
          client.egress.update({
            org: orgA.id,
            ...PATH,
            allowlist: ["z.example.org"],
            expectedUpdatedAt,
          }),
        ),
      ).toMatchObject({
        code: "CONFLICT",
        status: 409,
        data: { currentUpdatedAt: current },
      });
    }
    const ok = await client.egress.update({
      org: orgA.id,
      ...PATH,
      allowlist: ["z.example.org"],
      expectedUpdatedAt: current,
    });
    expect(ok.applied).toBe(true);
    expect(await auditCount()).toBe(1);
  });

  it("AC-7: a legacy PUT that lands between the read and the write makes it a CONFLICT with no audit row", async () => {
    await seed(orgA.id, {
      egressPolicy: "domain",
      egressAllowlist: ["a.example.org"],
    });
    vi.mocked(upsertRepoReviewSetting).mockImplementationOnce(async (args) => {
      // The legacy PUT takes no advisory lock: it commits under the handler's feet.
      await actualUpsert({
        db,
        organizationId: orgA.id,
        repoFullName: REPO,
        patch: { blockTolerance: "error" },
      });
      return actualUpsert(args);
    });
    const error = await failure(
      tokenClient(keyA).egress.update({
        org: orgA.id,
        ...PATH,
        add: ["n.example.org"],
      }),
    );
    expect(error).toMatchObject({ code: "CONFLICT", status: 409 });
    expect(
      (error.data as { currentUpdatedAt: string }).currentUpdatedAt,
    ).toEqual(expect.any(String));
    const row = await getRepoReviewSetting({
      db,
      organizationId: orgA.id,
      repoFullName: REPO,
    });
    expect(row?.egressAllowlist).toEqual(["a.example.org"]);
    expect(await auditCount()).toBe(0);
  });

  it("AC-8: an upload host warns in after.warnings", async () => {
    const result = await tokenClient(keyA).egress.update({
      org: orgA.id,
      ...PATH,
      level: "domain",
      add: ["storage.googleapis.com"],
    });
    expect(result.after.warnings).toContainEqual({
      code: "multi_tenant_upload_host",
      entry: "storage.googleapis.com",
    });
  });

  it("AC-9: one audit row per accepted change; history returns it; a refused write leaves none", async () => {
    const client = tokenClient(keyA);
    const result = await client.egress.update({
      org: orgA.id,
      ...PATH,
      level: "domain",
      add: ["a.example.org"],
      registries: true,
    });
    await failure(
      client.egress.update({ org: orgA.id, ...PATH, add: ["10.0.0.1"] }),
    );
    expect(await auditCount()).toBe(1);
    const history = await client.egress.history({ org: orgA.id, ...PATH });
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({
      id: result.auditId,
      actorUserId: userId,
      authKind: "api_key",
      levelBefore: null,
      levelAfter: "domain",
      hostsAdded: ["a.example.org"],
      hostsRemoved: [],
      registriesBefore: null,
      registriesAfter: true,
    });
  });

  it("AC-9: a failing audit insert rolls the settings change back", async () => {
    await seed(orgA.id, {
      egressPolicy: "domain",
      egressAllowlist: ["a.example.org"],
    });
    const before = await rowJson(orgA.id);
    vi.mocked(recordRepoEgressChange).mockRejectedValueOnce(
      new Error("audit down"),
    );
    await rejection(
      tokenClient(keyA).egress.update({
        org: orgA.id,
        ...PATH,
        add: ["b.example.org"],
      }),
    );
    expect(await rowJson(orgA.id)).toBe(before);
    expect(await auditCount()).toBe(0);
    expect(capture).not.toHaveBeenCalled();
  });

  it("AC-9: PostHog gets counts and levels, never a host or the key", async () => {
    await tokenClient(keyA).egress.update({
      org: orgA.id,
      ...PATH,
      level: "domain",
      add: ["secret.internal.example.org", "other.example.org"],
    });
    expect(capture).toHaveBeenCalledTimes(1);
    const event = capture.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      event: "repo_egress_changed",
      properties: {
        organizationId: orgA.id,
        repoFullName: REPO,
        levelBefore: null,
        levelAfter: "domain",
        addedCount: 2,
        removedCount: 0,
        authKind: "api_key",
      },
    });
    const serialized = JSON.stringify(event);
    for (const host of [
      "secret.internal.example.org",
      "other.example.org",
      "example.org",
      keyA,
    ]) {
      expect(serialized).not.toContain(host);
    }
  });

  it("dryRun and a no-op compute the result and write nothing", async () => {
    const client = tokenClient(keyA);
    const preview = await client.egress.update({
      org: orgA.id,
      ...PATH,
      level: "domain",
      add: ["a.example.org"],
      dryRun: true,
    });
    expect(preview).toMatchObject({ applied: false, auditId: null });
    expect(preview.before.stored.level).toBeNull();
    expect(preview.after.stored).toMatchObject({
      level: "domain",
      allowlist: ["a.example.org"],
    });
    expect(await rowCount()).toBe(0);
    expect(await auditCount()).toBe(0);
    await client.egress.update({
      org: orgA.id,
      ...PATH,
      level: "domain",
      add: ["a.example.org"],
    });
    const again = await client.egress.update({
      org: orgA.id,
      ...PATH,
      add: ["A.example.org"],
    });
    expect(again).toMatchObject({ applied: false, auditId: null });
    expect(await rowCount()).toBe(1);
    expect(await auditCount()).toBe(1);
    expect(capture).toHaveBeenCalledTimes(1);
    const dry = await client.egress.update({
      org: orgA.id,
      ...PATH,
      remove: ["a.example.org"],
      dryRun: true,
    });
    expect(dry.after.stored.allowlist).toEqual([]);
    expect(await auditCount()).toBe(1);
  });

  it("the rate limiter rejects a write with RATE_LIMIT_EXCEEDED and a dry run is not counted", async () => {
    vi.mocked(checkCliEgressWriteRateLimit).mockResolvedValue(false);
    const client = tokenClient(keyA);
    expect(
      await failure(
        client.egress.update({ org: orgA.id, ...PATH, level: "domain" }),
      ),
    ).toMatchObject({ code: "RATE_LIMIT_EXCEEDED" });
    expect(await rowCount()).toBe(0);
    vi.mocked(checkCliEgressWriteRateLimit).mockClear();
    await client.egress.update({
      org: orgA.id,
      ...PATH,
      level: "domain",
      dryRun: true,
    });
    expect(checkCliEgressWriteRateLimit).not.toHaveBeenCalled();
  });

  it("clears the level with null and keeps the row", async () => {
    await seed(orgA.id, {
      egressPolicy: "domain",
      egressAllowlist: ["a.example.org"],
    });
    const result = await tokenClient(keyA).egress.update({
      org: orgA.id,
      ...PATH,
      level: null,
    });
    expect(result.after.stored).toMatchObject({
      level: null,
      allowlist: ["a.example.org"],
    });
    const rows = await db
      .select()
      .from(repoReviewSettings)
      .where(eq(repoReviewSettings.organizationId, orgA.id));
    expect(rows).toHaveLength(1);
  });

  it("dryRun on a repo with no row reports no version: after.stored.updatedAt is null", async () => {
    const preview = await tokenClient(keyA).egress.update({
      org: orgA.id,
      ...PATH,
      level: "domain",
      add: ["a.example.org"],
      dryRun: true,
    });
    expect(preview.before.stored.updatedAt).toBeNull();
    expect(preview.after.stored.updatedAt).toBeNull();
    expect(preview.after.stored.updatedByUserId).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  it("CAS holds at millisecond precision against a stamp written with microseconds", async () => {
    await seed(orgA.id, {
      egressPolicy: "domain",
      egressAllowlist: ["a.example.org"],
    });
    await db.execute(
      sql`UPDATE repo_review_settings SET updated_at = '2026-11-20 10:00:00.123999' WHERE organization_id = ${orgA.id}`,
    );
    const read = await tokenClient(keyA).egress.get({ org: orgA.id, ...PATH });
    expect(read.stored.updatedAt).toBe("2026-11-20T10:00:00.123Z");
    const ok = await tokenClient(keyA).egress.update({
      org: orgA.id,
      ...PATH,
      add: ["b.example.org"],
      expectedUpdatedAt: read.stored.updatedAt,
    });
    expect(ok.applied).toBe(true);
    const stale = await failure(
      tokenClient(keyA).egress.update({
        org: orgA.id,
        ...PATH,
        add: ["c.example.org"],
        expectedUpdatedAt: "2026-11-20T10:00:00.124Z",
      }),
    );
    expect(stale).toMatchObject({ code: "CONFLICT" });
  });

  it("an expectedUpdatedAt that is not a date is invalid_input and writes nothing", async () => {
    const error = await failure(
      tokenClient(keyA).egress.update({
        org: orgA.id,
        ...PATH,
        level: "domain",
        expectedUpdatedAt: "yesterday",
      }),
    );
    expect(error).toMatchObject({
      code: "BAD_REQUEST",
      data: { errors: [{ code: "invalid_input" }] },
    });
    expect(await rowCount()).toBe(0);
  });

  it("two racing first writes that both read no row: one applies, the other is CONFLICT", async () => {
    const client = tokenClient(keyA);
    const results = await Promise.allSettled(
      ["x.example.org", "y.example.org"].map((host) =>
        client.egress.update({
          org: orgA.id,
          ...PATH,
          level: "domain",
          add: [host],
          expectedUpdatedAt: null,
        }),
      ),
    );
    const applied = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(applied).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
      data: { currentUpdatedAt: expect.any(String) },
    });
    expect(await auditCount()).toBe(1);
  });

  it("the advisory lock is per (org, repo): org B is not held up by org A's lock on the same repo", async () => {
    const keyB = await mintKey(userId, orgB.id);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const locker = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${orgA.id}/${REPO}`}, 0))`,
      );
      locked();
      await held;
    });
    await isLocked;
    const settled = (p: Promise<unknown>, ms: number) =>
      Promise.race([
        p.then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("pending"), ms)),
      ]);
    try {
      const writeB = tokenClient(keyB).egress.update({
        org: orgB.id,
        ...PATH,
        level: "domain",
      });
      expect(await settled(writeB, 2000)).toBe("settled");
      const writeA = tokenClient(keyA).egress.update({
        org: orgA.id,
        ...PATH,
        level: "domain",
      });
      expect(await settled(writeA, 300)).toBe("pending");
      release();
      await expect(writeA).resolves.toMatchObject({ applied: true });
    } finally {
      release();
      await locker;
    }
  });

  it("a key request is never origin-checked, even with a foreign Origin", async () => {
    const result = await clientFor(
      new Headers({
        "X-Daemon-Token": keyA,
        Origin: "https://evil.example.test",
      }),
      true,
    ).egress.update({ org: orgA.id, ...PATH, level: "domain" });
    expect(result.applied).toBe(true);
  });

  it("a session Origin of null is refused; a scheme-less trusted origin is accepted over https only", async () => {
    mockSession(userId);
    for (const origin of ["null", "http://terragonlabs.com"]) {
      expect(
        await failure(
          clientFor(new Headers({ Origin: origin }), true).egress.update({
            org: orgA.id,
            ...PATH,
            level: "domain",
          }),
        ),
      ).toMatchObject({
        code: "FORBIDDEN",
        data: { reason: "origin_mismatch" },
      });
    }
    expect(await rowCount()).toBe(0);
    const ok = await clientFor(
      new Headers({ Origin: "https://terragonlabs.com" }),
      true,
    ).egress.update({ org: orgA.id, ...PATH, level: "domain" });
    expect(ok.applied).toBe(true);
  });

  it("the audit row names the actor and credential: a key's id for a key, the session's id for a session", async () => {
    await tokenClient(keyA).egress.update({
      org: orgA.id,
      ...PATH,
      level: "domain",
    });
    mockSession(userId);
    await clientFor(new Headers({ Origin: APP }), true).egress.update({
      org: orgA.id,
      ...PATH,
      add: ["a.example.org"],
    });
    const rows = await db
      .select()
      .from(repoEgressAuditLog)
      .where(eq(repoEgressAuditLog.organizationId, orgA.id));
    const byKind = Object.fromEntries(rows.map((r) => [r.authKind, r]));
    expect(rows).toHaveLength(2);
    expect(byKind.session).toMatchObject({
      actorUserId: userId,
      credentialId: "sess_1",
    });
    expect(byKind.api_key?.actorUserId).toBe(userId);
    expect(byKind.api_key?.credentialId).toEqual(expect.any(String));
    expect(byKind.api_key?.credentialId).not.toBe(keyA);
    expect(byKind.api_key?.credentialId).not.toBe("sess_1");
  });

  it("a failing analytics client never fails a committed write", async () => {
    capture.mockImplementation(() => {
      throw new Error("posthog down");
    });
    const first = await tokenClient(keyA).egress.update({
      org: orgA.id,
      ...PATH,
      level: "domain",
    });
    expect(first.applied).toBe(true);
    vi.mocked(getPostHogServer).mockImplementation(() => {
      throw new Error("no client");
    });
    const second = await tokenClient(keyA).egress.update({
      org: orgA.id,
      ...PATH,
      add: ["a.example.org"],
    });
    expect(second.applied).toBe(true);
    expect(await auditCount()).toBe(2);
  });

  it("no analytics event and no rate-limit charge for a refused write", async () => {
    await failure(
      tokenClient(keyA).egress.update({
        org: orgA.id,
        ...PATH,
        level: "domain",
        add: ["10.0.0.1"],
      }),
    );
    expect(capture).not.toHaveBeenCalled();
    const memberId = (await createTestUser({ db })).user.id;
    const member = await createTestOrganization({
      db,
      userId: memberId,
      role: "member",
    });
    await failure(
      tokenClient(
        await mintKey(memberId, member.organization.id),
      ).egress.update({
        org: member.organization.id,
        ...PATH,
        level: "domain",
      }),
    );
    expect(checkCliEgressWriteRateLimit).toHaveBeenCalledTimes(1);
  });

  it("a full replace is canonicalized: case and duplicates collapse to one host", async () => {
    const result = await tokenClient(keyA).egress.update({
      org: orgA.id,
      ...PATH,
      level: "domain",
      allowlist: ["Example.COM", "example.com", " example.com "],
    });
    expect(result.after.stored.allowlist).toEqual(["example.com"]);
  });
});
