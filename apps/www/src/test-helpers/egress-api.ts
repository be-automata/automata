import { nanoid } from "nanoid";
import { expect, vi } from "vitest";

import { auth } from "@/lib/auth";

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
