import { createRouterClient, ORPCError } from "@orpc/server";
import { nanoid } from "nanoid";
import { expect, vi } from "vitest";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { checkRepoAdmin } from "@/lib/repo-admin";
import { egressRouter } from "@/server/orpc/egress-router";
import { isRepoInOrganizationScope } from "@/server-lib/user-repos";
import {
  createTestOrganization,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

/**
 * Shared setup of the egress API tests (principal, router and the `/api/v1`
 * mount): a real API key, a stubbed session and a rejection to inspect.
 */

/** Mint a real API key; `orgId` stamps `metadata.organizationId` (a personal key has none). */
export async function mintKey(
  userId: string,
  orgId?: string,
  metadata: Record<string, unknown> = {},
): Promise<string> {
  const stamped = orgId ? { organizationId: orgId, ...metadata } : metadata;
  const created = await auth.api.createApiKey({
    body: {
      name: `cli-${nanoid(8)}`,
      userId,
      expiresIn: 60 * 60 * 24,
      ...(Object.keys(stamped).length > 0 ? { metadata: stamped } : {}),
    },
  });
  return created.key;
}

/** Stub `auth.api.getSession` with a partial session: only the fields the principal reads. */
export function mockSession(
  userId: string,
  session: Record<string, unknown> = {},
) {
  return vi.spyOn(auth.api, "getSession").mockResolvedValue({
    user: { id: userId },
    session: { id: "sess_1", ...session },
  } as never);
}

/** What the promise rejected with; fails the test when it resolved. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).not.toBeNull();
  return error;
}

const TRUSTED_TEST_ORIGIN = "https://app.example.test";

/**
 * Add an origin to Better Auth's own trusted list (the one `isTrustedOrigin`
 * reads) and return it. The test env has no base URL in `process.env`, and
 * Better Auth never matches a scheme-less entry, so a test names a full origin.
 */
export async function trustAppOrigin(): Promise<string> {
  const context = await auth.$context;
  if (!context.trustedOrigins.includes(TRUSTED_TEST_ORIGIN)) {
    context.trustedOrigins.push(TRUSTED_TEST_ORIGIN);
  }
  return TRUSTED_TEST_ORIGIN;
}

/** A router client over the egress router; `allowSession` is the `/api/v1` mount. */
export function clientFor(headers: Headers, allowSession = false) {
  return createRouterClient(
    { egress: egressRouter },
    { context: { headers, allowSession } },
  );
}

/** A client that authenticates with an API key in `X-Daemon-Token`. */
export const tokenClient = (key: string) =>
  clientFor(new Headers({ "X-Daemon-Token": key }));

/** What a call rejected with, as `{code, status, data, message}`; fails when it resolved. */
export async function failure(promise: Promise<unknown>) {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(ORPCError);
  const e = error as ORPCError<string, unknown>;
  return { code: e.code, status: e.status, data: e.data, message: e.message };
}

export interface EgressWorld {
  userId: string;
  orgA: { id: string; slug: string };
  orgB: { id: string; slug: string };
  /** An API key stamped with org A. */
  keyA: string;
}

/**
 * The shared fixture of the egress API tests: a user in two orgs, a key for
 * org A, the public URL stub, and the repo-scope and repo-admin mocks (the
 * caller's file must `vi.mock` `@/lib/repo-admin` and `@/server-lib/user-repos`).
 */
export async function setupEgressWorld(): Promise<EgressWorld> {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
  vi.mocked(isRepoInOrganizationScope).mockResolvedValue(true);
  vi.mocked(checkRepoAdmin).mockResolvedValue("not-admin");
  const userId = (await createTestUser({ db })).user.id;
  const orgA = (await createTestOrganization({ db, userId, name: "Alpha" }))
    .organization;
  const orgB = (await createTestOrganization({ db, userId, name: "Beta" }))
    .organization;
  return { userId, orgA, orgB, keyA: await mintKey(userId, orgA.id) };
}
