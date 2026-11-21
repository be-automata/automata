import { nanoid } from "nanoid";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { checkRepoAdmin } from "@/lib/repo-admin";
import { mintDaemonToken } from "@/lib/daemon-token";
import { DaemonAuthUnavailableError } from "@/lib/daemon-auth-unavailable";
import * as daemonApiKey from "@/lib/daemon-api-key";
import { isRepoInOrganizationScope } from "@/server-lib/user-repos";
import { mintKey, mockSession, rejection } from "@/test-helpers/egress-api";
import { upsertRepoReviewSetting } from "@terragon/shared/model/repo-review-settings";
import {
  createTestOrganization,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { addOrganizationMember } from "@terragon/shared/model/organizations";

import {
  assertRepoInOrg,
  readEditAccess,
  resolveEgressOrg,
  resolveEgressPrincipal,
  type PrincipalErrors,
} from "./principal";

vi.mock("@/lib/repo-admin", () => ({ checkRepoAdmin: vi.fn() }));
vi.mock("@/server-lib/user-repos", () => ({
  isRepoInOrganizationScope: vi.fn(),
}));

class Refusal extends Error {
  constructor(
    readonly code: string,
    readonly data?: unknown,
  ) {
    super(code);
  }
}

const errors: PrincipalErrors = {
  UNAUTHORIZED: () => new Refusal("UNAUTHORIZED"),
  NOT_FOUND: (o) => new Refusal("NOT_FOUND", o),
  FORBIDDEN: (o) => new Refusal("FORBIDDEN", o.data),
  SERVICE_UNAVAILABLE: (o) => new Refusal("SERVICE_UNAVAILABLE", o.data),
};

async function refusal(promise: Promise<unknown>): Promise<Refusal> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(Refusal);
  return error as Refusal;
}

describe("resolveEgressPrincipal (step 1: the credential)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("accepts X-Daemon-Token and Authorization: Bearer the same way", async () => {
    const { user } = await createTestUser({ db });
    const key = await mintKey(user.id, "org_x");
    const forms = [
      new Headers({ "X-Daemon-Token": key }),
      new Headers({ Authorization: `Bearer ${key}` }),
    ];
    for (const headers of forms) {
      const principal = await resolveEgressPrincipal({ headers }, errors);
      expect(principal).toMatchObject({
        userId: user.id,
        authKind: "api_key",
        keyOrganizationId: "org_x",
      });
      expect(principal.credentialId).toBeTruthy();
    }
  });

  it("refuses an unknown key with 401 and never falls back to the cookie", async () => {
    const getSession = vi.spyOn(auth.api, "getSession");
    const error = await refusal(
      resolveEgressPrincipal(
        {
          headers: new Headers({ Authorization: "Bearer bogus" }),
          allowSession: true,
        },
        errors,
      ),
    );
    expect(error.code).toBe("UNAUTHORIZED");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("refuses a daemon token", async () => {
    const { user } = await createTestUser({ db });
    const token = await mintDaemonToken({
      userId: user.id,
      threadId: "t_1",
      threadChatId: "tc_1",
      name: `run-${nanoid(8)}`,
    });
    const error = await refusal(
      resolveEgressPrincipal(
        { headers: new Headers({ "X-Daemon-Token": token }) },
        errors,
      ),
    );
    expect(error.code).toBe("UNAUTHORIZED");
  });

  it("answers 503 auth_unavailable when the auth store fails", async () => {
    vi.spyOn(daemonApiKey, "verifyDaemonApiKey").mockRejectedValue(
      new DaemonAuthUnavailableError("down"),
    );
    const error = await refusal(
      resolveEgressPrincipal(
        { headers: new Headers({ "X-Daemon-Token": "any" }) },
        errors,
      ),
    );
    expect(error).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { reason: "auth_unavailable" },
    });
  });

  it("uses the session only when the mount allows it", async () => {
    const { user } = await createTestUser({ db });
    const getSession = mockSession(user.id);
    const none = await refusal(
      resolveEgressPrincipal({ headers: new Headers() }, errors),
    );
    expect(none.code).toBe("UNAUTHORIZED");
    expect(getSession).not.toHaveBeenCalled();
    const principal = await resolveEgressPrincipal(
      { headers: new Headers(), allowSession: true },
      errors,
    );
    expect(principal).toEqual({
      userId: user.id,
      authKind: "session",
      credentialId: "sess_1",
      keyOrganizationId: null,
    });
  });

  it("never falls back to the cookie when a credential header is present but unusable", async () => {
    const getSession = mockSession("u_cookie", { id: "sess_cookie" });
    const unusable: [string, string][] = [
      ["X-Daemon-Token", ""],
      ["Authorization", "Basic dXNlcjpwYXNz"],
      ["Authorization", "Bearer"],
      ["Authorization", "Bearer two tokens"],
    ];
    for (const init of unusable) {
      const error = await refusal(
        resolveEgressPrincipal(
          { headers: new Headers([init]), allowSession: true },
          errors,
        ),
      );
      expect(error.code).toBe("UNAUTHORIZED");
    }
    expect(getSession).not.toHaveBeenCalled();
  });

  it("answers 503 auth_unavailable when the session store fails", async () => {
    vi.spyOn(auth.api, "getSession").mockRejectedValue(
      new Error("connection refused"),
    );
    const error = await refusal(
      resolveEgressPrincipal(
        { headers: new Headers(), allowSession: true },
        errors,
      ),
    );
    expect(error).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { reason: "auth_unavailable" },
    });
  });

  it("refuses a cookie-less request on the session mount with 401", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null);
    const error = await refusal(
      resolveEgressPrincipal(
        { headers: new Headers(), allowSession: true },
        errors,
      ),
    );
    expect(error.code).toBe("UNAUTHORIZED");
  });
});

describe("resolveEgressOrg (step 3: the org)", () => {
  async function world() {
    const { user } = await createTestUser({ db });
    const a = await createTestOrganization({ db, userId: user.id, name: "A" });
    const b = await createTestOrganization({ db, userId: user.id, name: "B" });
    return { user, a: a.organization, b: b.organization };
  }
  const apiKey = (userId: string, keyOrganizationId: string | null) => ({
    userId,
    authKind: "api_key" as const,
    credentialId: "k",
    keyOrganizationId,
  });
  const session = (userId: string) => ({
    userId,
    authKind: "session" as const,
    credentialId: "s",
    keyOrganizationId: null,
  });

  it("a key resolves its own org by id or slug", async () => {
    const { user, a } = await world();
    for (const param of [a.id, a.slug]) {
      await expect(
        resolveEgressOrg(apiKey(user.id, a.id), param, errors),
      ).resolves.toEqual({ id: a.id, slug: a.slug });
    }
  });

  it("a key for B naming A is org_mismatch, even when the user is in both", async () => {
    const { user, a, b } = await world();
    const error = await refusal(
      resolveEgressOrg(apiKey(user.id, b.id), a.id, errors),
    );
    expect(error).toMatchObject({
      code: "FORBIDDEN",
      data: { reason: "org_mismatch" },
    });
  });

  it("a personal key is org_required", async () => {
    const { user, a } = await world();
    const error = await refusal(
      resolveEgressOrg(apiKey(user.id, null), a.id, errors),
    );
    expect(error.data).toEqual({ reason: "org_required" });
  });

  it("a key whose user left the org is org_forbidden", async () => {
    const stranger = (await createTestUser({ db })).user;
    const { a } = await world();
    const error = await refusal(
      resolveEgressOrg(apiKey(stranger.id, a.id), a.id, errors),
    );
    expect(error.data).toEqual({ reason: "org_forbidden" });
  });

  it("a session resolves {org} by id or slug, whatever its active org", async () => {
    const { user, a } = await world();
    for (const param of [a.id, a.slug]) {
      await expect(
        resolveEgressOrg(session(user.id), param, errors),
      ).resolves.toEqual({ id: a.id, slug: a.slug });
    }
  });

  it("a session answers org_forbidden alike for a non-member and an unknown org", async () => {
    const { a } = await world();
    const outsider = (await createTestUser({ db })).user;
    const nonMember = await refusal(
      resolveEgressOrg(session(outsider.id), a.id, errors),
    );
    const unknown = await refusal(
      resolveEgressOrg(session(outsider.id), "no-such-org", errors),
    );
    expect(nonMember.data).toEqual({ reason: "org_forbidden" });
    expect(unknown.data).toEqual(nonMember.data);
    expect(unknown.code).toBe(nonMember.code);
  });
});

describe("assertRepoInOrg (step 4) and readEditAccess (step 5)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes when the org has a row, even when the scope rule says no", async () => {
    const { user } = await createTestUser({ db });
    const { organization } = await createTestOrganization({
      db,
      userId: user.id,
    });
    await upsertRepoReviewSetting({
      db,
      organizationId: organization.id,
      repoFullName: "acme/widgets",
      patch: { egressPolicy: "none" },
    });
    vi.mocked(isRepoInOrganizationScope).mockResolvedValue(false);
    await expect(
      assertRepoInOrg({
        org: { id: organization.id, slug: organization.slug },
        owner: "Acme",
        repo: "Widgets",
        errors,
      }),
    ).resolves.toMatchObject({
      repoFullName: "acme/widgets",
      row: { repoFullName: "acme/widgets" },
    });
  });

  it("answers one identical NOT_FOUND for every not-in-org cause", async () => {
    const { user } = await createTestUser({ db });
    const mine = await createTestOrganization({ db, userId: user.id });
    const other = await createTestOrganization({ db, userId: user.id });
    // A row only in ANOTHER org must not count.
    await upsertRepoReviewSetting({
      db,
      organizationId: other.organization.id,
      repoFullName: "acme/widgets",
      patch: { egressPolicy: "none" },
    });
    vi.mocked(isRepoInOrganizationScope).mockResolvedValue(false);
    const org = { id: mine.organization.id, slug: mine.organization.slug };
    const withRowElsewhere = await refusal(
      assertRepoInOrg({ org, owner: "acme", repo: "widgets", errors }),
    );
    const absent = await refusal(
      assertRepoInOrg({ org, owner: "acme", repo: "nothing", errors }),
    );
    expect(withRowElsewhere.code).toBe("NOT_FOUND");
    expect(withRowElsewhere.data).toEqual({ message: "Repository not found" });
    expect(absent.data).toEqual(withRowElsewhere.data);
  });

  it("canEdit follows checkRepoWriteAccess; a failed lookup is permission_unverified", async () => {
    const { user } = await createTestUser({ db });
    const member = await createTestUser({ db });
    const { organization } = await createTestOrganization({
      db,
      userId: user.id,
      role: "owner",
    });
    await addOrganizationMember({
      db,
      organizationId: organization.id,
      userId: member.user.id,
      role: "member",
    });
    const args = {
      organizationId: organization.id,
      repoFullName: "acme/widgets",
    };
    await expect(readEditAccess({ userId: user.id, ...args })).resolves.toEqual(
      { canEdit: true, readOnlyReason: null },
    );
    vi.mocked(checkRepoAdmin).mockResolvedValue("not-admin");
    await expect(
      readEditAccess({ userId: member.user.id, ...args }),
    ).resolves.toEqual({ canEdit: false, readOnlyReason: "not_repo_admin" });
    vi.mocked(checkRepoAdmin).mockResolvedValue("lookup-failed");
    await expect(
      readEditAccess({ userId: member.user.id, ...args }),
    ).resolves.toEqual({
      canEdit: false,
      readOnlyReason: "permission_unverified",
    });
  });
});
