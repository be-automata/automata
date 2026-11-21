import { createRouterClient, ORPCError } from "@orpc/server";
import { nanoid } from "nanoid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { checkRepoAdmin } from "@/lib/repo-admin";
import { isRepoInOrganizationScope } from "@/server-lib/user-repos";
import { repoEgressAuditLog } from "@terragon/shared/db/schema";
import { recordRepoEgressChange } from "@terragon/shared/model/repo-egress-audit-log";
import { upsertRepoReviewSetting } from "@terragon/shared/model/repo-review-settings";
import {
  createTestOrganization,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { egressRouter } from "./egress-router";

vi.mock("@/lib/repo-admin", () => ({ checkRepoAdmin: vi.fn() }));
vi.mock("@/server-lib/user-repos", () => ({
  isRepoInOrganizationScope: vi.fn(),
}));

const REPO = "acme/widgets";
const PATH = { owner: "acme", repo: "widgets" };

async function mintKey(userId: string, organizationId?: string) {
  const created = await auth.api.createApiKey({
    body: {
      name: `cli-${nanoid(8)}`,
      userId,
      expiresIn: 60 * 60 * 24,
      ...(organizationId ? { metadata: { organizationId } } : {}),
    },
  });
  return created.key;
}

function clientFor(headers: Headers, allowSession = false) {
  return createRouterClient(
    { egress: egressRouter },
    { context: { headers, allowSession } },
  );
}

const tokenClient = (key: string) =>
  clientFor(new Headers({ "X-Daemon-Token": key }));

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ORPCError);
  const e = error as ORPCError<string, unknown>;
  return { code: e.code, status: e.status, data: e.data, message: e.message };
}

describe("egress router: reads", () => {
  let userId: string;
  let orgA: { id: string; slug: string };
  let orgB: { id: string; slug: string };
  let keyA: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
    vi.mocked(isRepoInOrganizationScope).mockResolvedValue(true);
    vi.mocked(checkRepoAdmin).mockResolvedValue("not-admin");
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
    vi.spyOn(auth.api, "getSession").mockResolvedValue({
      user: { id: userId },
      session: { id: "sess_1", activeOrganizationId: orgB.id },
    } as never);
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
    vi.spyOn(auth.api, "getSession").mockResolvedValue({
      user: { id: outsider },
      session: { id: "sess_2", activeOrganizationId: orgA.id },
    } as never);
    expect(
      await failure(
        clientFor(new Headers(), true).egress.get({ org: orgA.id, ...PATH }),
      ),
    ).toMatchObject({ code: "FORBIDDEN", data: { reason: "org_forbidden" } });
  });

  it("a session is not accepted where the mount does not allow it", async () => {
    const spy = vi.spyOn(auth.api, "getSession").mockResolvedValue({
      user: { id: userId },
      session: { id: "sess_1" },
    } as never);
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
    await record(orgA.id, "one.example.org");
    await record(orgA.id, "two.example.org");
    await record(orgB.id, "other.example.org");
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
