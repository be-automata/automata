import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { checkRepoAdmin } from "@/lib/repo-admin";
import { isRepoInOrganizationScope } from "@/server-lib/user-repos";
import {
  clientFor,
  failure,
  mintKey,
  mockSession,
  setupEgressWorld,
  tokenClient,
} from "@/test-helpers/egress-api";
import { repoEgressAuditLog } from "@terragon/shared/db/schema";
import { recordRepoEgressChange } from "@terragon/shared/model/repo-egress-audit-log";
import { upsertRepoReviewSetting } from "@terragon/shared/model/repo-review-settings";
import {
  createTestOrganization,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

vi.mock("@/lib/repo-admin", () => ({ checkRepoAdmin: vi.fn() }));
vi.mock("@/server-lib/user-repos", () => ({
  isRepoInOrganizationScope: vi.fn(),
}));

const REPO = "acme/widgets";
const PATH = { owner: "acme", repo: "widgets" };

describe("egress router: reads", () => {
  let userId: string;
  let orgA: { id: string; slug: string };
  let orgB: { id: string; slug: string };
  let keyA: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ userId, orgA, orgB, keyA } = await setupEgressWorld());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("AC-1: a key for the org reads a repo with no row", async () => {
    const view = await tokenClient(keyA).egress.get({ org: orgA.id, ...PATH });
    expect(view.stored.level).toBeNull();
    expect(view.box.enforced).toBe(false);
    expect(view.cell).toMatchObject({ ok: true });
    expect(view.org).toEqual({ id: orgA.id, slug: orgA.slug });
    expect(view.repo).toBe(REPO);
    expect(view.canEdit).toBe(true);
  });

  it("reads the stored row of the named org, never another org's", async () => {
    for (const [org, host] of [
      [orgA, "a.example.org"],
      [orgB, "b.example.org"],
    ] as const) {
      await upsertRepoReviewSetting({
        db,
        organizationId: org.id,
        repoFullName: REPO,
        patch: { egressPolicy: "domain", egressAllowlist: [host] },
      });
    }
    const view = await tokenClient(keyA).egress.get({
      org: orgA.slug,
      ...PATH,
    });
    expect(view.stored.allowlist).toEqual(["a.example.org"]);
  });

  it("AC-3: a key for B naming A is org_mismatch; a personal key is org_required", async () => {
    const keyB = await mintKey(userId, orgB.id);
    expect(
      await failure(tokenClient(keyB).egress.get({ org: orgA.id, ...PATH })),
    ).toMatchObject({
      code: "FORBIDDEN",
      status: 403,
      data: { reason: "org_mismatch" },
    });
    const personal = await mintKey(userId);
    expect(
      await failure(
        tokenClient(personal).egress.get({ org: orgA.id, ...PATH }),
      ),
    ).toMatchObject({ code: "FORBIDDEN", data: { reason: "org_required" } });
  });

  it("AC-3: a bogus key is 401, and so is no credential", async () => {
    expect(
      await failure(tokenClient("bogus").egress.get({ org: orgA.id, ...PATH })),
    ).toMatchObject({ code: "UNAUTHORIZED", status: 401 });
    expect(
      await failure(
        clientFor(new Headers()).egress.get({ org: orgA.id, ...PATH }),
      ),
    ).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("AC-3: the Bearer form behaves like X-Daemon-Token", async () => {
    const bearer = clientFor(
      new Headers({ Authorization: `Bearer ${keyA}` }),
    ).egress.get({ org: orgA.id, ...PATH });
    await expect(bearer).resolves.toMatchObject({ repo: REPO });
  });

  it("AC-4: a session whose active org is B reads org A by path, and a non-member is refused", async () => {
    // Active org is B; the path names A. The principal never reads it.
    mockSession(userId, { activeOrganizationId: orgB.id });
    await upsertRepoReviewSetting({
      db,
      organizationId: orgA.id,
      repoFullName: REPO,
      patch: { egressPolicy: "none" },
    });
    const session = clientFor(new Headers(), true);
    const view = await session.egress.get({ org: orgA.slug, ...PATH });
    expect(view.org.id).toBe(orgA.id);
    expect(view.stored.level).toBe("none");

    const outsider = (await createTestUser({ db })).user.id;
    mockSession(outsider, { id: "sess_2", activeOrganizationId: orgA.id });
    expect(
      await failure(
        clientFor(new Headers(), true).egress.get({ org: orgA.id, ...PATH }),
      ),
    ).toMatchObject({ code: "FORBIDDEN", data: { reason: "org_forbidden" } });
  });

  it("a session is not accepted where the mount does not allow it", async () => {
    const spy = mockSession(userId);
    expect(
      await failure(
        clientFor(new Headers()).egress.get({ org: orgA.id, ...PATH }),
      ),
    ).toMatchObject({ code: "UNAUTHORIZED" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("AC-5: a non-admin reads with canEdit false and a reason; a failed lookup is permission_unverified", async () => {
    const memberId = (await createTestUser({ db })).user.id;
    const member = await createTestOrganization({
      db,
      userId: memberId,
      role: "member",
    });
    const key = await mintKey(memberId, member.organization.id);
    const read = () =>
      tokenClient(key).egress.get({ org: member.organization.id, ...PATH });
    await expect(read()).resolves.toMatchObject({
      canEdit: false,
      readOnlyReason: "not_repo_admin",
    });
    vi.mocked(checkRepoAdmin).mockResolvedValue("lookup-failed");
    await expect(read()).resolves.toMatchObject({
      canEdit: false,
      readOnlyReason: "permission_unverified",
    });
  });

  it("answers byte-identical NOT_FOUND for a repo outside the org, whatever the cause", async () => {
    vi.mocked(isRepoInOrganizationScope).mockResolvedValue(false);
    // A row in another org for the same repo must not change the answer.
    await upsertRepoReviewSetting({
      db,
      organizationId: orgB.id,
      repoFullName: REPO,
      patch: { egressPolicy: "none" },
    });
    const client = tokenClient(keyA);
    const withRowElsewhere = await failure(
      client.egress.get({ org: orgA.id, ...PATH }),
    );
    const absent = await failure(
      client.egress.get({ org: orgA.id, owner: "acme", repo: "nothing" }),
    );
    expect(withRowElsewhere).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(JSON.stringify(withRowElsewhere)).toBe(JSON.stringify(absent));
  });

  it("history: newest first, org-fenced, paged by an opaque cursor", async () => {
    const record = (organizationId: string, host: string) =>
      recordRepoEgressChange({
        db,
        organizationId,
        repoFullName: REPO,
        actorUserId: userId,
        authKind: "api_key",
        credentialId: "key_1",
        before: { level: null, allowlist: null, registries: null },
        after: { level: "domain", allowlist: [host], registries: null },
      });
    const one = await record(orgA.id, "one.example.org");
    await record(orgA.id, "two.example.org");
    await record(orgB.id, "other.example.org");
    // Two inserts can share a millisecond; the tie order is the random id, so
    // pin "one" older to keep "newest first" deterministic.
    await db
      .update(repoEgressAuditLog)
      .set({ createdAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(repoEgressAuditLog.id, one.id));
    const client = tokenClient(keyA);
    const first = await client.egress.history({
      org: orgA.id,
      ...PATH,
      limit: 1,
    });
    expect(first.entries.map((e) => e.hostsAdded)).toEqual([
      ["two.example.org"],
    ]);
    expect(first.nextBefore).toEqual(expect.any(String));
    const second = await client.egress.history({
      org: orgA.id,
      ...PATH,
      limit: 1,
      before: first.nextBefore!,
    });
    expect(second.entries.map((e) => e.hostsAdded)).toEqual([
      ["one.example.org"],
    ]);
    expect(second.nextBefore).toBeNull();
    expect(await db.$count(repoEgressAuditLog)).toBeGreaterThanOrEqual(3);
  });

  it("history: an audit row with a level outside the list reads as null, not a 500", async () => {
    const row = await recordRepoEgressChange({
      db,
      organizationId: orgA.id,
      repoFullName: REPO,
      actorUserId: userId,
      authKind: "api_key",
      credentialId: "key_1",
      before: { level: null, allowlist: null, registries: null },
      after: { level: "domain", allowlist: [], registries: null },
    });
    // Only a raw write can do this: the column is text with no CHECK.
    await db
      .update(repoEgressAuditLog)
      .set({ levelAfter: "everything" as never })
      .where(eq(repoEgressAuditLog.id, row.id));
    const page = await tokenClient(keyA).egress.history({
      org: orgA.id,
      ...PATH,
    });
    expect(page.entries.find((e) => e.id === row.id)?.levelAfter).toBeNull();
  });

  it("history: a forged cursor is a declared BAD_REQUEST invalid_input", async () => {
    const error = await failure(
      tokenClient(keyA).egress.history({
        org: orgA.id,
        ...PATH,
        limit: 10,
        before: "not-a-cursor",
      }),
    );
    expect(error).toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
      data: { errors: [{ code: "invalid_input" }] },
    });
  });

  it("history: a well-formed cursor whose date Postgres cannot hold is BAD_REQUEST, not a 500", async () => {
    for (const createdAt of [
      "+275760-09-13T00:00:00.000Z",
      "-000001-01-01T00:00:00.000Z",
      "0000-01-01T00:00:00.000Z",
    ]) {
      const before = Buffer.from(
        JSON.stringify({ createdAt, id: "x" }),
      ).toString("base64url");
      const error = await failure(
        tokenClient(keyA).egress.history({
          org: orgA.id,
          ...PATH,
          limit: 10,
          before,
        }),
      );
      expect(error).toMatchObject({
        code: "BAD_REQUEST",
        data: { errors: [{ code: "invalid_input" }] },
      });
    }
  });

  it("history: rows that share a createdAt are each returned exactly once across pages", async () => {
    const ids: string[] = [];
    for (const host of [
      "one.example.org",
      "two.example.org",
      "three.example.org",
    ]) {
      const row = await recordRepoEgressChange({
        db,
        organizationId: orgA.id,
        repoFullName: REPO,
        actorUserId: userId,
        authKind: "api_key",
        credentialId: "key_1",
        before: { level: null, allowlist: null, registries: null },
        after: { level: "domain", allowlist: [host], registries: null },
      });
      ids.push(row.id);
    }
    await db
      .update(repoEgressAuditLog)
      .set({ createdAt: new Date("2026-11-20T10:00:00.000Z") })
      .where(eq(repoEgressAuditLog.organizationId, orgA.id));
    const client = tokenClient(keyA);
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 5; page++) {
      const out = await client.egress.history({
        org: orgA.id,
        ...PATH,
        limit: 1,
        ...(before ? { before } : {}),
      });
      seen.push(...out.entries.map((e) => e.id));
      if (!out.nextBefore) break;
      before = out.nextBefore;
    }
    expect(seen).toEqual([...ids].sort().reverse());
  });

  it("list: the org's repos with egress fields, none from another org", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgA.id,
      repoFullName: "acme/zeta",
      patch: { egressPolicy: "domain", egressAllowlist: ["z.example.org"] },
    });
    await upsertRepoReviewSetting({
      db,
      organizationId: orgA.id,
      repoFullName: "acme/alpha",
      patch: { cellEgressRegistries: true },
    });
    // A row with no egress field at all is not an egress row.
    await upsertRepoReviewSetting({
      db,
      organizationId: orgA.id,
      repoFullName: "acme/plain",
      patch: { blockTolerance: "error" },
    });
    await upsertRepoReviewSetting({
      db,
      organizationId: orgB.id,
      repoFullName: "acme/beta-only",
      patch: { egressPolicy: "none" },
    });
    const out = await tokenClient(keyA).egress.list({ org: orgA.slug });
    expect(out.org).toEqual({ id: orgA.id, slug: orgA.slug });
    expect(out.repos.map((r) => r.repo)).toEqual(["acme/alpha", "acme/zeta"]);
    expect(out.repos[1]).toMatchObject({
      level: "domain",
      allowlistCount: 1,
      registries: null,
    });
  });

  it("a canary key never appears in a response body", async () => {
    const view = await tokenClient(keyA).egress.get({ org: orgA.id, ...PATH });
    const refused = await failure(
      tokenClient(keyA).egress.get({ org: orgB.id, ...PATH }),
    );
    expect(JSON.stringify([view, refused])).not.toContain(keyA);
  });
});
