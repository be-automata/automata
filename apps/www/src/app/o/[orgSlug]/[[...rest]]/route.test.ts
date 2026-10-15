import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NextRequest } from "next/server";
import { Session } from "@terragon/shared";
import { session as sessionTable } from "@terragon/shared/db/schema";
import {
  addOrganizationMember,
  createOrganization,
} from "@terragon/shared/model/organizations";
import { createTestUser } from "@terragon/shared/model/test-helpers";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { mockLoggedInUser, mockLoggedOutUser } from "@/test-helpers/mock-next";
import { GET } from "./route";

function request(path: string) {
  return new NextRequest(`http://localhost${path}`);
}

function params(orgSlug: string, rest?: string[]) {
  return { params: Promise.resolve({ orgSlug, rest }) };
}

async function activeOrgOf(sessionId: string) {
  const [row] = await db
    .select({ activeOrganizationId: sessionTable.activeOrganizationId })
    .from(sessionTable)
    .where(eq(sessionTable.id, sessionId));
  return row?.activeOrganizationId ?? null;
}

describe("GET /o/[orgSlug]/[[...rest]]", () => {
  let session: Session;
  let memberSlug: string;
  let memberOrgId: string;
  let strangerSlug: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const created = await createTestUser({ db });
    session = created.session;
    const suffix = nanoid(8).toLowerCase();
    memberSlug = `acme-${suffix}`;
    strangerSlug = `stranger-${suffix}`;
    const memberOrg = await createOrganization({
      db,
      name: "Acme",
      slug: memberSlug,
    });
    await createOrganization({ db, name: "Stranger", slug: strangerSlug });
    await addOrganizationMember({
      db,
      organizationId: memberOrg.id,
      userId: created.user.id,
    });
    memberOrgId = memberOrg.id;
    await mockLoggedInUser(session);
  });

  it("switches a member's session to the org and redirects to the path", async () => {
    const res = await GET(
      request(`/o/${memberSlug}/settings/repos?tab=env`),
      params(memberSlug, ["settings", "repos"]),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://localhost/settings/repos?tab=env",
    );
    expect(await activeOrgOf(session.id)).toBe(memberOrgId);
  });

  it("redirects a member to the dashboard when there is no path", async () => {
    const res = await GET(request(`/o/${memberSlug}`), params(memberSlug));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/dashboard");
    expect(await activeOrgOf(session.id)).toBe(memberOrgId);
  });

  it("404s for an org the user does not belong to, without touching the session", async () => {
    const setActive = vi.spyOn(auth.api, "setActiveOrganization");
    const res = await GET(
      request(`/o/${strangerSlug}/settings`),
      params(strangerSlug, ["settings"]),
    );
    expect(res.status).toBe(404);
    expect(setActive).not.toHaveBeenCalled();
    expect(await activeOrgOf(session.id)).toBeNull();
  });

  it("404s for an unknown slug, the same as for a non-member", async () => {
    const setActive = vi.spyOn(auth.api, "setActiveOrganization");
    const res = await GET(
      request("/o/no-such-org-anywhere/settings"),
      params("no-such-org-anywhere", ["settings"]),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
    expect(setActive).not.toHaveBeenCalled();
  });

  it("404s an unsafe target before switching the session", async () => {
    const setActive = vi.spyOn(auth.api, "setActiveOrganization");
    const res = await GET(
      request(`/o/${memberSlug}/%2F%2Fevil.example`),
      params(memberSlug, ["//evil.example"]),
    );
    expect(res.status).toBe(404);
    expect(setActive).not.toHaveBeenCalled();
    expect(await activeOrgOf(session.id)).toBeNull();
  });

  it("404s a link that points at another org link", async () => {
    const res = await GET(
      request(`/o/${memberSlug}/o/${strangerSlug}`),
      params(memberSlug, ["o", strangerSlug]),
    );
    expect(res.status).toBe(404);
  });

  it("sends a signed-out visitor to login with the link as the return path", async () => {
    await mockLoggedOutUser();
    const res = await GET(
      request(`/o/${memberSlug}/settings?tab=env`),
      params(memberSlug, ["settings"]),
    );
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("http://localhost");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("returnUrl")).toBe(
      `/o/${memberSlug}/settings?tab=env`,
    );
  });
});
